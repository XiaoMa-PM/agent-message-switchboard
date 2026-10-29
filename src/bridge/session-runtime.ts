// INPUT: Owned broker requests, live OS adapters, fixed official lifecycle metadata and original host/route factories.
// OUTPUT: First-start lifecycle, shared connections, live descriptions, captured-binding checks and an identified-request seam for mixed entries.
// POS: Runtime composition only; caller must prove helper ownership, fixed pins and native adapters.
import { createDuplex, type DuplexConnection } from './duplex.ts';
import { createClaudeChannel, createAppClaudeChannel, type ClaudeChannelOptions, type ClaudeChannelResult, type PreparedResult,
  type ClaudeChannelApi } from './claude-channel.ts';
import { type AppSkillProfile, assertAppSkillProfile } from './skill-request.ts';
import { assertResponseCapacity } from './response-capacity.ts';
import { type StdioRequest } from './stdio-rpc.ts';
import { resolveClaudePeer, type ProcessSnapshot, type KernelPeer, type Inspect, type Classify,
  type BinaryPin } from '../adapters/claude/peer-identity.ts';
import { ClaudeSessionEpochs, type EpochBinding } from '../adapters/claude/session-epoch.ts';
import { type ClaudeRoute } from '../adapters/claude/registration.ts';
import { createDshSourceBinding } from '../adapters/dsh/source.ts';
import { parseEndpoint, type Envelope, type Endpoint, type Harness, type PushOutcome } from '../protocol/message.ts';

type Push = (frame: Envelope) => PushOutcome | Promise<PushOutcome>;
export type SessionRuntimeOptions = Readonly<{ host: Parameters<typeof createDshSourceBinding>[0]; inspect: Inspect;
  classify: Classify; cliPin: BinaryPin; assertOpen: () => void; guardDispatch: () => void;
  getRoute: (identity: ProcessSnapshot, sid: string) => Promise<ClaudeRoute>;
  makeDshPush: (execution: unknown, endpoint: Endpoint) => Push;
  makeClaudePush: (binding: EpochBinding) => Push;
  resolvePeer?: (peer: KernelPeer) => Promise<ProcessSnapshot>; retireEnded?: boolean }>;
type Registered = Readonly<{ binding: EpochBinding; connection: DuplexConnection; cwd: string }>;
type DshAgent = Readonly<{ ctx: unknown; session: Readonly<{ header: Readonly<{ cwd?: string }> }> }>;
type DshRegistered = Readonly<{ agent: DshAgent; session: DshAgent['session']; header: DshAgent['session']['header'];
  ctx: unknown; connection: DuplexConnection; cwd: string | null }>;
export type EndpointDescription = Readonly<{ endpoint: Endpoint; cwd: string | null }>;
type DirectoryEntry = Readonly<EndpointDescription & { verify: () => Promise<void>; assertCurrent: () => void }>;

function key(identity: ProcessSnapshot | EpochBinding['identity']): string {
  return JSON.stringify([identity.pid, identity.uid, identity.pidVersion, identity.uniqueId]);
}

function payload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_HOOK_EVENT');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('INVALID_HOOK_EVENT');
  return value as Record<string, unknown>;
}

function lifecycle(raw: Record<string, unknown>, event: 'SessionStart' | 'SessionEnd'): void {
  const required = ['session_id', 'transcript_path', 'cwd', 'hook_event_name', event === 'SessionStart' ? 'source' : 'reason'];
  const optional = ['permission_mode', 'agent_id', 'agent_type', 'model', 'effort', 'prompt_id', 'scratchpad_dir', 'session_title'];
  if (!required.every(field => Object.hasOwn(raw, field))
      || Object.keys(raw).some(field => !required.includes(field) && !optional.includes(field))
      || required.some(field => typeof raw[field] !== 'string')
      || ['scratchpad_dir', 'session_title'].some(field => Object.hasOwn(raw, field) && typeof raw[field] !== 'string')
      || raw.hook_event_name !== event || (event === 'SessionStart' && raw.source !== 'startup')) {
    throw new Error('INVALID_LIFECYCLE_EVENT');
  }
}

class SessionRuntime {
  #options: SessionRuntimeOptions;
  #epochs = new ClaudeSessionEpochs();
  #records = new Map<string, Registered>();
  #dsh = new Map<unknown, DshRegistered>();
  #closed = false;
  #bind: ReturnType<typeof createDshSourceBinding>;
  #duplex: ReturnType<typeof createDuplex>;
  #channel: ReturnType<typeof createClaudeChannel>;

  #appChecks?: AppRuntimeChecks;

  constructor(options: SessionRuntimeOptions, channelFactory = createClaudeChannel,
    appChecks?: AppRuntimeChecks) {
    this.#appChecks = appChecks;
    this.#options = Object.freeze({ ...options, cliPin: Object.freeze({ ...options.cliPin }) });
    this.#bind = createDshSourceBinding(options.host);
    this.#duplex = createDuplex({ host: options.host, assertOpen: () => this.#open(), guardDispatch: options.guardDispatch,
      verifyClaude: binding => this.#verify(binding), assertClaudeCurrent: binding => this.#current(binding) });
    this.#channel = channelFactory({ assertOpen: () => this.#open(), verify: binding => this.#verify(binding),
      assertCurrent: binding => this.#current(binding), beforeDispatch: (_binding, request) =>
        assertResponseCapacity(request, [...this.#dsh.values()].map(record => record.connection.endpoint.nativeSessionId)),
      getConnection: binding => {
        const record = this.#records.get(key(binding.identity));
        if (!record || record.binding !== binding) throw new Error('UNREGISTERED_CLAUDE_SESSION');
        return record.connection;
      } });
  }

  #open(): void {
    if (this.#closed) throw new Error('SESSION_RUNTIME_CLOSED');
    this.#options.assertOpen();
  }

  #current(binding: EpochBinding): undefined {
    this.#open(); this.#epochs.verify(binding, binding.identity); this.#appChecks?.assertCurrent(); return undefined;
  }

  async #resolve(peer: KernelPeer): Promise<ProcessSnapshot> {
    this.#open();
    const identity = this.#options.resolvePeer ? await this.#options.resolvePeer(peer)
      : await resolveClaudePeer(peer, this.#options.inspect, this.#options.classify, this.#options.cliPin);
    this.#open(); return identity;
  }

  async #verify(binding: EpochBinding): Promise<void> {
    this.#current(binding);
    const current = await this.#resolve(binding.identity);
    this.#epochs.verify(binding, current);
    if (this.#appChecks) await this.#appChecks.verifyBinding(binding);
    this.#current(binding);
  }

  #dshCurrent(record: DshRegistered): void {
    this.#open();
    if (this.#dsh.get(record.agent) !== record || record.agent.session !== record.session
        || record.agent.session.header !== record.header || record.agent.ctx !== record.ctx
        || JSON.stringify(this.#bind({ agent: record.agent })) !== JSON.stringify(record.connection.endpoint)) {
      throw new Error('RUNTIME_ENDPOINT_CHANGED');
    }
  }

  #cliCurrent(record: Registered): void {
    this.#current(record.binding);
    if (this.#records.get(key(record.binding.identity)) !== record) throw new Error('RUNTIME_ENDPOINT_CHANGED');
  }

  #directory(harness: Harness): readonly DirectoryEntry[] {
    if (harness === 'dsh') return [...this.#dsh.values()].map(record => ({
      endpoint: record.connection.endpoint, cwd: record.cwd,
      verify: async () => this.#dshCurrent(record), assertCurrent: () => this.#dshCurrent(record) }));
    if (harness === 'claude-code') return [...this.#records.values()].map(record => ({
      endpoint: record.connection.endpoint, cwd: record.cwd,
      verify: () => this.#verify(record.binding), assertCurrent: () => this.#cliCurrent(record) }));
    return [];
  }

  async describe(harness: Harness): Promise<readonly EndpointDescription[]> {
    this.#open();
    if (!['dsh', 'claude-code', 'codex'].includes(harness)) throw new Error('INVALID_RUNTIME_HARNESS');
    const selected = this.#directory(harness);
    for (const entry of selected) {
      entry.assertCurrent(); await entry.verify(); this.#open(); entry.assertCurrent();
    }
    for (const entry of selected) entry.assertCurrent();
    return Object.freeze(selected.map(entry => Object.freeze({ endpoint: entry.endpoint, cwd: entry.cwd })));
  }

  async verifyEndpoint(value: Endpoint): Promise<void> {
    this.#open(); const endpoint = parseEndpoint(value);
    const entry = this.#directory(endpoint.harness).find(candidate => candidate.endpoint.endpointId === endpoint.endpointId);
    if (!entry) throw new Error('UNKNOWN_RUNTIME_ENDPOINT');
    if (JSON.stringify(entry.endpoint) !== JSON.stringify(endpoint)) throw new Error('RUNTIME_ENDPOINT_CHANGED');
    entry.assertCurrent(); await entry.verify(); this.#open(); entry.assertCurrent();
  }

  registerDsh(execution: unknown): DuplexConnection {
    this.#open();
    const endpoint = this.#bind(execution);
    const agent = (execution as { agent: DshAgent }).agent;
    const existing = this.#dsh.get(agent);
    if (existing) {
      return this.#duplex.registerDsh(execution, this.#options.makeDshPush(execution, endpoint));
    }
    const connection = this.#duplex.registerDsh(execution, this.#options.makeDshPush(execution, endpoint));
    this.#dsh = new Map([...this.#dsh, [agent, Object.freeze({ agent, connection, session: agent.session,
      header: agent.session.header, ctx: agent.ctx, cwd: agent.session.header.cwd ?? null })]]);
    return connection;
  }

  async #start(identity: ProcessSnapshot, raw: Record<string, unknown>): Promise<PreparedResult> {
    const ticket = this.#epochs.begin(identity, raw.session_id as string);
    try {
      lifecycle(raw, 'SessionStart');
      const route = await this.#options.getRoute(identity, ticket.nativeSessionId);
      this.#open();
      const binding = this.#epochs.activate(ticket, route);
      const connection = await this.#duplex.registerClaude(binding, this.#options.makeClaudePush(binding));
      this.#current(binding);
      this.#records = new Map([...this.#records, [key(identity), Object.freeze({ binding, connection, cwd: raw.cwd as string })]]);
      return Object.freeze({ prepared: true });
    } catch (error) { this.#epochs.revoke(identity); throw error; }
  }

  async handle(request: StdioRequest): Promise<PreparedResult | ClaudeChannelResult> {
    return this.handleIdentified(await this.#resolve(request.peer), request);
  }

  async handleIdentified(identity: ProcessSnapshot, request: StdioRequest): Promise<PreparedResult | ClaudeChannelResult> {
    this.#open();
    const raw = payload(request.payload);
    if (raw.hook_event_name === 'SessionStart') return this.#start(identity, raw);
    if (raw.hook_event_name === 'SessionEnd') {
      this.#epochs.revoke(identity);
      if (this.#options.retireEnded) this.#records = new Map([...this.#records].filter(([id]) => id !== key(identity)));
      lifecycle(raw, 'SessionEnd');
      return Object.freeze({ prepared: true });
    }
    if (raw.hook_event_name !== 'PreToolUse' && raw.hook_event_name !== 'PostToolUse') throw new Error('INVALID_HOOK_EVENT');
    const record = this.#records.get(key(identity));
    if (!record) throw new Error('UNREGISTERED_CLAUDE_SESSION');
    this.#epochs.verify(record.binding, identity);
    return raw.hook_event_name === 'PreToolUse' ? this.#channel.pre(record.binding, raw) : this.#channel.post(record.binding, raw);
  }

  attachDirectory(read: () => Promise<unknown>): () => void {
    this.#open(); return this.#channel.attachDirectory(read);
  }

  captureClaudeRegistrationCheck(): () => void {
    this.#open();
    const selected = Object.freeze([...this.#records.values()]);
    return () => {
      this.#open();
      for (const record of selected) this.#cliCurrent(record);
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const record of this.#records.values()) this.#epochs.revoke(record.binding.identity);
  }
}

export type AppRuntimeChecks = Readonly<{ verifyBinding: (binding: EpochBinding) => Promise<void>;
  assertCurrent: () => void }>;

function exposeRuntime(runtime: SessionRuntime) {
  return Object.freeze({ captureClaudeRegistrationCheck: () => runtime.captureClaudeRegistrationCheck(),
    attachDirectory: (read: () => Promise<unknown>) => runtime.attachDirectory(read),
    handle: (request: StdioRequest) => runtime.handle(request),
    registerDsh: (execution: unknown) => runtime.registerDsh(execution), close: () => runtime.close(),
    describe: (harness: Harness) => runtime.describe(harness),
    verifyEndpoint: (endpoint: Endpoint) => runtime.verifyEndpoint(endpoint) });
}

export function createSessionRuntime(options: SessionRuntimeOptions) {
  return exposeRuntime(new SessionRuntime(options));
}

export function createMixedCoreRuntime(options: SessionRuntimeOptions,
  channelFactory: (channelOptions: ClaudeChannelOptions) => ClaudeChannelApi, checks: AppRuntimeChecks) {
  const runtime = new SessionRuntime(options, channelFactory, checks);
  return Object.freeze({ ...exposeRuntime(runtime),
    handleIdentified: (identity: ProcessSnapshot, request: StdioRequest) => runtime.handleIdentified(identity, request) });
}

export function createAppChannelSessionRuntime(options: SessionRuntimeOptions, profile: AppSkillProfile,
  checks: AppRuntimeChecks) {
  assertAppSkillProfile(profile);
  return exposeRuntime(new SessionRuntime(options,
    (channelOptions: ClaudeChannelOptions) => createAppClaudeChannel(channelOptions, profile), checks));
}
