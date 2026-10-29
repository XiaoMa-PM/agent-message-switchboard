// INPUT: Owned broker requests, fixed standalone/App CLI pins, App confirmation and original host route/push factories.
// OUTPUT: One shared-epoch duplex with per-entry Start quotas, per-target guards and CLI-then-admitted-App End ordering.
// POS: Mixed App+CLI composition; entries are chosen by kernel ancestry only, never by payload shape.
import { createMixedCoreRuntime, type SessionRuntimeOptions } from './session-runtime.ts';
import { createClaudeChannel, createAppClaudeChannel, type ClaudeChannelApi, type ClaudeChannelOptions,
  type ClaudeChannelResult, type PreparedResult } from './claude-channel.ts';
import { AppAdmission, type PendingAppCandidate } from './app-admission.ts';
import { parseAppHook } from './app-hook.ts';
import { captureAppSocket, verifyAppSocket, type AppSocketPin } from './app-socket.ts';
import { createAppSkillProfile } from './skill-request.ts';
import { resolveAppAncestor, assertStandaloneAncestry } from './claude-ancestry.ts';
import { resolveClaudePeerAmong, type ProcessSnapshot, type BinaryPin, type KernelPeer } from '../adapters/claude/peer-identity.ts';
import { type ClaudeRoute } from '../adapters/claude/registration.ts';
import { type EpochBinding } from '../adapters/claude/session-epoch.ts';
import { type StdioRequest } from './stdio-rpc.ts';
import { type DuplexConnection } from './duplex.ts';
import { type Endpoint, type Harness } from '../protocol/message.ts';

export type MixedSurface = 'cli' | 'desktop';
type Result = PreparedResult | ClaudeChannelResult;
type Route = (identity: ProcessSnapshot, sid: string, socket: AppSocketPin) => Promise<ClaudeRoute>;
export type MixedRuntimeOptions = Readonly<Pick<SessionRuntimeOptions, 'host' | 'inspect' | 'assertOpen' | 'guardDispatch'
  | 'makeDshPush' | 'makeClaudePush'> & { runId: string; cliSessionId: string; cliSocketPath: string;
  cliPin: BinaryPin; appCliPin: BinaryPin; wrapperPins: readonly BinaryPin[]; appPin: BinaryPin;
  appHelperPins: readonly BinaryPin[]; getCliRoute: Route; getAppRoute: Route; onAppEnd: (requestId: string) => void;
  observe?: (surface: MixedSurface, request: StdioRequest, action: () => Promise<Result>) => Promise<Result> }>;
type Candidate = Readonly<{ nativeSessionId: string; cli: ProcessSnapshot; app: ProcessSnapshot; socket: AppSocketPin;
  job: Promise<unknown> }>;
type CliState = Readonly<{ state: 'unused' | 'starting' | 'bound' | 'ended'; identity?: ProcessSnapshot; socket?: AppSocketPin }>;
type Classified = Readonly<{ kind: 'cli' | 'app'; cli: ProcessSnapshot; app?: ProcessSnapshot }>;

class Rejected extends Error {}
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const lower = (value: unknown) => typeof value === 'string' ? value.toLowerCase() : null;
const key = (row: Readonly<{ pid: number; uid: number; pidVersion: number; uniqueId: string }>) =>
  JSON.stringify([row.pid, row.uid, row.pidVersion, row.uniqueId]);
const matches = (row: ProcessSnapshot, pin: BinaryPin) => row.exe === pin.path && row.sha256 === pin.sha256;
function deferred<T>() { const value = Promise.withResolvers<T>(); void value.promise.catch(() => {}); return value; }
function plain(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Rejected('INVALID_HOOK_EVENT');
  return value as Record<string, unknown>;
}

class MixedSessionRuntime {
  #options: MixedRuntimeOptions;
  #core: ReturnType<typeof createMixedCoreRuntime>;
  #admission: AppAdmission<Candidate, void>;
  #closed = false;
  #revoked = deferred<string>();
  #cliBound = deferred<void>();
  #cli: CliState = Object.freeze({ state: 'unused' });
  #appUsed = false;
  #candidate?: Candidate;
  #kinds = new Map<string, 'cli' | 'app'>();
  #appRouteRequested = deferred<ProcessSnapshot>();
  #appRoute = deferred<ClaudeRoute>();
  #appParser: ReturnType<typeof createAppSkillProfile>;

  constructor(options: MixedRuntimeOptions) {
    this.#options = Object.freeze({ ...options });
    this.#appParser = createAppSkillProfile(options.runId);
    this.#admission = new AppAdmission({ runId: options.runId, assertOpen: () => this.#open(),
      verifyCandidate: candidate => this.#verifyCandidate(candidate), activateCandidate: candidate => this.#activate(candidate),
      onRevoke: reason => this.#shutdown(reason) });
    this.#core = createMixedCoreRuntime({ host: options.host, inspect: options.inspect, cliPin: options.cliPin,
      classify: row => this.#classifyRow(row), assertOpen: () => this.#open(), retireEnded: true,
      resolvePeer: peer => this.#resolveBinding(peer),
      guardDispatch: () => { this.#ready(); options.guardDispatch(); },
      getRoute: (identity, sid) => this.#route(identity, sid),
      makeClaudePush: binding => { const push = options.makeClaudePush(binding);
        return frame => { this.#guardTarget(binding); return push(frame); }; },
      makeDshPush: (execution, endpoint) => { const push = options.makeDshPush(execution, endpoint);
        return frame => { this.#ready(); return push(frame); }; },
    }, channelOptions => this.#channels(channelOptions),
    { assertCurrent: () => this.#sockets(), verifyBinding: binding => this.#verifyBinding(binding) });
  }

  #classifyRow(row: ProcessSnapshot): 'cli' | 'wrapper' | 'unsupported' {
    if (matches(row, this.#options.cliPin) || matches(row, this.#options.appCliPin)) return 'cli';
    return this.#options.wrapperPins.some(pin => matches(row, pin)) ? 'wrapper' : 'unsupported';
  }
  #open(): void {
    if (this.#closed) throw new Error('MIXED_RUN_CLOSED');
    this.#options.assertOpen();
  }
  #closeRun(reason = 'MIXED_RUN_CLOSED'): void { this.#admission.invalidate(reason); }
  #shutdown(reason: string): void {
    if (this.#closed) return;
    this.#closed = true; this.#revoked.resolve(reason);
    const error = new Error('MIXED_RUN_CLOSED');
    this.#appRoute.reject(error); this.#appRouteRequested.reject(error); this.#cliBound.reject(error);
    this.#core?.close();
  }
  #cliEnded(): boolean { return this.#cli.state === 'ended'; }
  #ready(): void {
    this.#open();
    if (this.#admission.state !== 'active' || !['bound', 'ended'].includes(this.#cli.state)) throw new Rejected('MIXED_NOT_READY');
  }
  #sockets(): void {
    try {
      this.#open();
      if (this.#cli.socket && this.#cli.state !== 'ended') verifyAppSocket(this.#cli.socket);
      if (this.#candidate) verifyAppSocket(this.#candidate.socket);
    } catch (error) { this.#closeRun(); throw error; }
  }
  #guardTarget(binding: EpochBinding): void {
    if (this.#kinds.get(key(binding.identity)) === 'app') this.#admission.assertActive();
    else if (this.#cli.state !== 'bound') throw new Rejected('SESSION_EPOCH_REVOKED');
    this.#sockets();
  }

  async #classify(peer: KernelPeer): Promise<Classified> {
    const open = () => this.#open(); const o = this.#options;
    const { snapshot, pinIndex } = await resolveClaudePeerAmong(peer, o.inspect, row => this.#classifyRow(row), [o.cliPin, o.appCliPin]);
    open();
    if (pinIndex === 0) {
      await assertStandaloneAncestry(snapshot, { inspect: o.inspect, assertOpen: open,
        forbidden: [o.appPin, ...o.appHelperPins, o.cliPin, o.appCliPin] });
      return Object.freeze({ kind: 'cli', cli: snapshot });
    }
    const app = await resolveAppAncestor(snapshot, { inspect: o.inspect, appPin: o.appPin, appHelperPins: o.appHelperPins, assertOpen: open });
    return Object.freeze({ kind: 'app', cli: snapshot, app });
  }
  async #resolveBinding(peer: KernelPeer): Promise<ProcessSnapshot> {
    try {
      const o = this.#options;
      return (await resolveClaudePeerAmong(peer, o.inspect, row => this.#classifyRow(row), [o.cliPin, o.appCliPin])).snapshot;
    } catch (error) {
      if (!(this.#cli.state === 'ended' && this.#kinds.get(key(peer as ProcessSnapshot)) === 'cli')) this.#closeRun();
      throw error;
    }
  }
  async #verifyBinding(binding: EpochBinding): Promise<void> {
    if (this.#kinds.get(key(binding.identity)) === 'app') {
      if (!this.#candidate) throw new Error('MIXED_RUN_CLOSED');
      return this.#verifyCandidate(this.#candidate);
    }
    return this.#verifyCli(binding.identity);
  }
  async #verifyCli(identity: EpochBinding['identity']): Promise<void> {
    try {
      const o = this.#options; const bound = this.#cli.identity;
      const { snapshot, pinIndex } = await resolveClaudePeerAmong(identity, o.inspect, row => this.#classifyRow(row), [o.cliPin, o.appCliPin]);
      if (this.#cliEnded()) throw new Rejected('SESSION_EPOCH_REVOKED');
      if (pinIndex !== 0 || !same(snapshot, bound)) throw new Error('INVALID_PEER_IDENTITY');
      await assertStandaloneAncestry(snapshot, { inspect: o.inspect, assertOpen: () => this.#open(),
        forbidden: [o.appPin, ...o.appHelperPins, o.cliPin, o.appCliPin] });
      if (this.#cliEnded()) throw new Rejected('SESSION_EPOCH_REVOKED');
      this.#sockets();
    } catch (error) {
      if (this.#cliEnded()) throw new Rejected('SESSION_EPOCH_REVOKED');
      this.#closeRun(); throw error;
    }
  }
  async #verifyCandidate(candidate: Candidate): Promise<void> {
    try {
      const o = this.#options; this.#sockets();
      const { snapshot, pinIndex } = await resolveClaudePeerAmong(candidate.cli, o.inspect, row => this.#classifyRow(row), [o.cliPin, o.appCliPin]);
      this.#sockets();
      if (pinIndex !== 1 || !same(snapshot, candidate.cli)) throw new Error('INVALID_APP_GENERATION');
      const app = await resolveAppAncestor(snapshot, { inspect: o.inspect, appPin: o.appPin, appHelperPins: o.appHelperPins,
        assertOpen: () => this.#open() });
      this.#sockets();
      if (!same(app, candidate.app) || this.#candidate !== candidate) throw new Error('INVALID_APP_GENERATION');
    } catch (error) { this.#closeRun(); throw error; }
  }
  async #activate(candidate: Candidate): Promise<void> {
    if (lower(candidate.nativeSessionId) === lower(this.#options.cliSessionId)) throw new Error('DUPLICATE_SESSION');
    const route = await this.#options.getAppRoute(candidate.cli, candidate.nativeSessionId, candidate.socket);
    this.#sockets();
    if (route.socket !== candidate.socket.path || this.#candidate !== candidate) throw new Error('INVALID_APP_ROUTE');
    await this.#verifyCandidate(candidate); this.#sockets(); this.#appRoute.resolve(route);
    await candidate.job; this.#sockets();
    await this.#verifyCandidate(candidate); this.#sockets();
  }
  async #route(identity: ProcessSnapshot, sid: string): Promise<ClaudeRoute> {
    const kind = this.#kinds.get(key(identity));
    if (kind === 'app') { this.#appRouteRequested.resolve(identity); return this.#appRoute.promise; }
    if (kind !== 'cli' || this.#cli.state !== 'starting' || !same(identity, this.#cli.identity)) throw new Error('UNREGISTERED_CLAUDE_SESSION');
    const socket = captureAppSocket(this.#options.cliSocketPath);
    if (socket.path !== this.#options.cliSocketPath) throw new Error('APP_SOCKET_UNAVAILABLE');
    this.#cli = Object.freeze({ ...this.#cli, socket });
    const route = await this.#options.getCliRoute(identity, sid, socket); this.#sockets();
    if (route.socket !== socket.path) throw new Error('INVALID_CLI_ROUTE');
    return route;
  }
  #channels(channelOptions: ClaudeChannelOptions): ClaudeChannelApi {
    const cli = createClaudeChannel(channelOptions); const app = createAppClaudeChannel(channelOptions, this.#appParser);
    const pick = (binding: EpochBinding) => this.#kinds.get(key(binding.identity)) === 'app' ? app : cli;
    return Object.freeze({ pre: (binding: EpochBinding, payload: unknown) => pick(binding).pre(binding, payload),
      post: (binding: EpochBinding, payload: unknown) => pick(binding).post(binding, payload),
      attachDirectory: (read: () => Promise<unknown>) => {
        const releaseCli = cli.attachDirectory(read);
        try { const releaseApp = app.attachDirectory(read); return () => { try { releaseCli(); } finally { releaseApp(); } }; }
        catch (error) { releaseCli(); throw error; }
      } });
  }

  async #cliStart(cli: ProcessSnapshot, request: StdioRequest, raw: Record<string, unknown>): Promise<Result> {
    if (this.#cli.state !== 'unused' || lower(raw.session_id) !== lower(this.#options.cliSessionId)) {
      this.#closeRun('MIXED_UNEXPECTED_START'); throw new Error('MIXED_UNEXPECTED_START');
    }
    this.#cli = Object.freeze({ state: 'starting', identity: cli }); this.#kinds = new Map([...this.#kinds, [key(cli), 'cli' as const]]);
    try {
      const result = await this.#core.handleIdentified(cli, request); this.#open();
      this.#cli = Object.freeze({ ...this.#cli, state: 'bound' }); this.#cliBound.resolve(); return result;
    } catch (error) { this.#closeRun(); throw error; }
  }
  async #cliEnd(cli: ProcessSnapshot, request: StdioRequest): Promise<Result> {
    if (this.#cli.state !== 'bound' || !same(cli, this.#cli.identity)) {
      this.#closeRun('MIXED_UNEXPECTED_END'); throw new Error('MIXED_UNEXPECTED_END');
    }
    this.#cli = Object.freeze({ ...this.#cli, state: 'ended' });
    try { return await this.#core.handleIdentified(cli, request); }
    catch (error) { this.#closeRun(); throw error; }
  }
  async #handleCli(cli: ProcessSnapshot, request: StdioRequest): Promise<Result> {
    const raw = plain(request.payload);
    if (raw.hook_event_name === 'SessionStart') return this.#cliStart(cli, request, raw);
    if (raw.hook_event_name === 'SessionEnd') return this.#cliEnd(cli, request);
    if (this.#cli.state === 'bound') this.#ready();
    return this.#core.handleIdentified(cli, request);
  }

  async #appStart(request: StdioRequest, cli: ProcessSnapshot, app: ProcessSnapshot, socketPath: string | null): Promise<Result> {
    if (this.#appUsed) throw new Error('MIXED_UNEXPECTED_START');
    this.#appUsed = true;
    const hook = request.payload as { session_id: unknown };
    if (lower(hook.session_id) === lower(this.#options.cliSessionId)) throw new Error('DUPLICATE_SESSION');
    if (socketPath === null) throw new Error('APP_SOCKET_UNAVAILABLE');
    const socket = captureAppSocket(socketPath); this.#kinds = new Map([...this.#kinds, [key(cli), 'app' as const]]);
    const job = this.#core.handleIdentified(cli, request); void job.catch(() => {});
    const observed = await Promise.race([this.#appRouteRequested.promise, job.then(() => { throw new Error('APP_ROUTE_NOT_REQUESTED'); })]);
    this.#open();
    if (!same(observed, cli)) throw new Error('INVALID_APP_GENERATION');
    const candidate = Object.freeze({ nativeSessionId: hook.session_id as string, cli, app, socket, job }); this.#candidate = candidate;
    this.#admission.observeStart({ nativeSessionId: candidate.nativeSessionId, cliGeneration: cli, appGeneration: app, candidateOpaque: candidate });
    return Object.freeze({ prepared: true });
  }
  #appEnd(requestId: string, hook: Record<string, unknown>, cli: ProcessSnapshot, app: ProcessSnapshot): Result {
    if (this.#cli.state !== 'ended') throw new Error('MIXED_APP_END_BEFORE_CLI');
    const candidate = this.#candidate;
    if (this.#admission.state !== 'active' || !candidate || !same(cli, candidate.cli) || !same(app, candidate.app)
        || lower(hook.session_id) !== lower(candidate.nativeSessionId)) throw new Error('MIXED_UNEXPECTED_END');
    this.#admission.invalidate('APP_SESSION_ENDED'); this.#options.onAppEnd(requestId);
    return Object.freeze({ prepared: true });
  }
  async #handleApp(cli: ProcessSnapshot, app: ProcessSnapshot, request: StdioRequest): Promise<Result> {
    try {
      const wrapped = parseAppHook(request.payload);
      const hook = wrapped.hook as { hook_event_name: string };
      const inner = Object.freeze({ ...request, payload: wrapped.hook });
      if (hook.hook_event_name === 'SessionStart') return await this.#appStart(inner, cli, app, wrapped.startup!.socketPath);
      if (hook.hook_event_name === 'SessionEnd') return this.#appEnd(request.requestId, wrapped.hook as Record<string, unknown>, cli, app);
      if (this.#admission.state === 'pending' || this.#admission.state === 'activating') {
        this.#appParser.parseInvocation(wrapped.hook); await this.#verifyCandidate(this.#candidate!);
        throw new Rejected('APP_ADMISSION_NOT_ACTIVE');
      }
      this.#admission.assertActive(); this.#ready();
      await this.#verifyCandidate(this.#candidate!); this.#admission.assertActive();
      return await this.#core.handleIdentified(cli, inner);
    } catch (error) {
      if (!(error instanceof Rejected)) this.#closeRun(error instanceof Error
        && ['MIXED_APP_END_BEFORE_CLI', 'MIXED_UNEXPECTED_END'].includes(error.message) ? error.message : 'MIXED_RUN_CLOSED');
      throw error;
    }
  }

  async handle(request: StdioRequest): Promise<Result> {
    this.#open();
    const who = await this.#classify(request.peer); this.#open();
    const action = () => who.kind === 'cli' ? this.#handleCli(who.cli, request) : this.#handleApp(who.cli, who.app!, request);
    return this.#options.observe ? this.#options.observe(who.kind === 'cli' ? 'cli' : 'desktop', request, action) : action();
  }
  registerDsh(execution: unknown): DuplexConnection {
    const connection = this.#core.registerDsh(execution);
    return Object.freeze({ endpoint: connection.endpoint,
      connect: async (target: string) => { this.#ready(); return connection.connect(target); },
      send: async (value: unknown) => { this.#ready(); return connection.send(value); },
      reply: async (value: unknown) => { this.#ready(); return connection.reply(value); } });
  }
  surfaceOf(endpoint: Endpoint): MixedSurface {
    const sid = lower(endpoint?.nativeSessionId);
    if (endpoint?.harness === 'claude-code' && sid === lower(this.#options.cliSessionId) && this.#cli.state === 'bound') return 'cli';
    if (endpoint?.harness === 'claude-code' && this.#candidate && sid === lower(this.#candidate.nativeSessionId)
      && this.#admission.state === 'active') return 'desktop';
    throw new Error('UNKNOWN_MIXED_SURFACE');
  }
  async describe(harness: Harness) {
    this.#open();
    const entries = await this.#core.describe(harness); this.#open();
    if (harness !== 'claude-code') return entries;
    return Object.freeze(entries.filter(entry => { try { this.surfaceOf(entry.endpoint); return true; } catch { return false; } }));
  }
  verifyEndpoint(endpoint: Endpoint): Promise<void> { return this.#core.verifyEndpoint(endpoint); }
  attachDirectory(read: () => Promise<unknown>): () => void {
    return this.#core.attachDirectory(async () => { this.#open(); const result = await read(); this.#open(); return result; });
  }
  activate(candidateId: string, confirmation: unknown): Promise<void> { return this.#admission.activate(candidateId, confirmation); }
  invalidate(reason?: string): void { this.#closeRun(reason); }
  get whenRevoked(): Promise<string> { return this.#revoked.promise; }
  get whenCandidate(): Promise<PendingAppCandidate> { return this.#admission.whenCandidate; }
  get whenCliBound(): Promise<void> { return this.#cliBound.promise; }
}

export function createMixedSessionRuntime(options: MixedRuntimeOptions) {
  const runtime = new MixedSessionRuntime(options);
  return Object.freeze({ whenRevoked: runtime.whenRevoked, whenCandidate: runtime.whenCandidate, whenCliBound: runtime.whenCliBound,
    handle: (request: StdioRequest) => runtime.handle(request), registerDsh: (execution: unknown) => runtime.registerDsh(execution),
    describe: (harness: Harness) => runtime.describe(harness), verifyEndpoint: (endpoint: Endpoint) => runtime.verifyEndpoint(endpoint),
    surfaceOf: (endpoint: Endpoint) => runtime.surfaceOf(endpoint),
    attachDirectory: (read: () => Promise<unknown>) => runtime.attachDirectory(read),
    activate: (candidateId: string, confirmation: unknown) => runtime.activate(candidateId, confirmation),
    invalidate: (reason?: string) => runtime.invalidate(reason), close: () => runtime.invalidate() });
}
