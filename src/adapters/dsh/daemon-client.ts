// INPUT: msd control socket, fixed desktop host binding, original SDK Agents/message factory and agent lifecycle.
// OUTPUT: One attached adapter channel: registration, autoRegister/replyMode switches, deliver results, letterTurnEnd, receipts.
// POS: DSH desktop side of msd; host binds the sender, msd routes; no Router, identity proof or model call.
import { connectControl, type ControlClient } from '../../daemon/control-client.ts';
import { parseEnvelope, type PushOutcome } from '../../protocol/message.ts';
import { createDshSourceBinding } from './source.ts';
import { deliveryOf } from '../../protocol/inbound-header.ts';
import { isActPreset, type ActPreset } from '../../protocol/peer-tiers.ts';
import { isReplyMode, type ReplyMode } from '../../protocol/reply-mode-text.ts';
import { type LetterTurnEnd } from './act-gate.ts';
import { createDshInboxPush, createDshReceiptPush } from './inbox.ts';

type Host = Parameters<typeof createDshSourceBinding>[0];
type Message = Readonly<{ id: string; role: 'user'; source?: unknown }>;
export type DshAgent = Parameters<typeof createDshInboxPush<Message>>[0]['agent'];
export type DaemonClientOptions = Readonly<{ socketPath: string; instanceId: string; host: Host;
  getAgent: (id: string) => DshAgent | undefined; listAgents: () => Iterable<DshAgent>;
  describe: (agent: DshAgent) => Readonly<{ title: string | null; cwd: string | null }>;
  createMessage: Parameters<typeof createDshInboxPush<Message>>[0]['createMessage'];
  connect?: (path: string) => Promise<ControlClient>; retryMs?: number; onAttached?: (attached: boolean) => void;
  onAuto?: (event: AutoEvent) => void }>;
// Outcome of one auto-register step, for the beacon: never a raw error, path or session id.
export type AutoEvent = Readonly<{ kind: 'listed'; count: number } | { kind: 'registered' | 'refused' | 'skipped' | 'disposed' }
  | { kind: 'failed'; code: string }>;
const unknown: PushOutcome = Object.freeze({ state: 'delivery-unknown', transport: null });
const codeOf = (error: unknown) => error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'INTERNAL_ERROR';

class DaemonClient {
  #options: DaemonClientOptions;
  #bind: ReturnType<typeof createDshSourceBinding>;
  #client?: ControlClient;
  #autoRegister = false;
  #replyMode: ReplyMode | null = null;
  #actPreset: ActPreset | null = null;
  #wanted = new Map<string, 'manual' | 'auto'>();
  #closed = false;
  #timer?: NodeJS.Timeout;
  #ready = Promise.withResolvers<void>();

  constructor(options: DaemonClientOptions) {
    this.#options = options; this.#bind = createDshSourceBinding(options.host);
  }

  get whenAttached(): Promise<void> { return this.#ready.promise; }
  get attached(): boolean { return !!this.#client; }
  // What msd last said, only while attached: a lost or closed channel means the model gets no mode line and the rules say confirm.
  get knownReplyMode(): ReplyMode | null { return this.#replyMode; }
  // Likewise for the act preset; the act gate reads a missing one as read-only.
  get knownActPreset(): ActPreset | null { return this.#actPreset; }

  start(): void { void this.#attach(); }

  async #attach(): Promise<void> {
    if (this.#closed) return;
    try {
      const client = await (this.#options.connect ?? connectControl)(this.#options.socketPath);
      client.onEvent((event, data) => this.#event(client, event, data));
      const attached = await client.request('adapter.attach', { harness: 'dsh', instanceId: this.#options.instanceId }) as
        { autoRegister: boolean; replyMode?: unknown; actPreset?: unknown };
      if (this.#closed) { client.close(); return; }
      this.#client = client; this.#autoRegister = attached.autoRegister === true;
      this.#replyMode = isReplyMode(attached.replyMode) ? attached.replyMode : null;
      this.#actPreset = isActPreset(attached.actPreset) ? attached.actPreset : null;
      void client.whenClosed.then(() => this.#lost(client));
      for (const [id, mode] of this.#wanted) await this.#send(id, mode).catch(() => {});
      this.#sweep();
      this.#ready.resolve();
    } catch { this.#options.onAttached?.(false); this.#retry(); return; }
    this.#options.onAttached?.(true);
  }

  #lost(client: ControlClient): void {
    if (this.#client !== client) return;
    this.#client = undefined; this.#replyMode = null; this.#actPreset = null; this.#options.onAttached?.(false); this.#retry();
  }

  #retry(): void {
    if (this.#closed || this.#timer) return;
    this.#timer = setTimeout(() => { this.#timer = undefined; void this.#attach(); }, this.#options.retryMs ?? 5000);
  }

  #event(client: ControlClient, event: string, data: unknown): void {
    if (event === 'config') {
      this.#autoRegister = (data as { autoRegister?: unknown })?.autoRegister === true;
      const mode = (data as { replyMode?: unknown })?.replyMode;
      this.#replyMode = isReplyMode(mode) ? mode : null;
      const preset = (data as { actPreset?: unknown })?.actPreset;
      this.#actPreset = isActPreset(preset) ? preset : null;
      this.#sweep();
    }
    if (event === 'deliver') void this.#deliver(client, data);
    if (event === 'receipt') this.#receipt(data);
  }

  // A no-reply receipt for a session this client registered goes to that agent as it is. msd wants no result, so an
  // unknown, unregistered or changed session drops it.
  #receipt(data: unknown): void {
    const { receiptId, sessionId, text } = (data ?? {}) as Record<string, unknown>;
    if (typeof receiptId !== 'string' || typeof sessionId !== 'string' || typeof text !== 'string') return;
    const agent = this.#options.getAgent(sessionId);
    if (!agent || !this.#wanted.has(agent.id)) return;
    try {
      createDshReceiptPush({ host: this.#options.host, agent, endpoint: this.#bind({ agent }),
        createMessage: this.#options.createMessage })(receiptId, text);
    } catch { /* Dropped, like a receipt to an offline sender. */ }
  }

  async #deliver(client: ControlClient, data: unknown): Promise<void> {
    let envelope;
    try { envelope = parseEnvelope((data as { envelope?: unknown })?.envelope); } catch { return; }
    let result: Record<string, unknown> = { ...unknown };
    const agent = this.#options.getAgent(envelope.recipient.nativeSessionId);
    if (!agent || !this.#wanted.has(agent.id)) result = { ...unknown, error: 'TARGET_OFFLINE' };
    else {
      try {
        const local = this.#bind({ agent });
        const push = createDshInboxPush({ host: this.#options.host, agent, endpoint: local,
          createMessage: this.#options.createMessage, senders: ['claude-code', 'codex'],
          delivery: deliveryOf(data) });
        result = { ...await push({ ...envelope, recipient: local }) };
      } catch { result = { ...unknown }; }
    }
    await client.request('deliver.result', { messageId: envelope.messageId, ...result }).catch(() => {});
  }

  #sessionOf(execution: unknown): DshAgent {
    const endpoint = this.#bind(execution);
    return this.#options.getAgent(endpoint.nativeSessionId)!;
  }

  async #send(id: string, mode: 'manual' | 'auto'): Promise<unknown> {
    const agent = this.#options.getAgent(id);
    if (!agent) throw new Error('INVALID_DSH_SOURCE');
    this.#bind({ agent });
    const { title, cwd } = this.#options.describe(agent);
    const result = await this.request('register', { sessionId: id, title, cwd, clientSurface: 'desktop', mode }) as
      { registered?: unknown };
    if (result?.registered !== true && this.#wanted.get(id) === mode) {
      this.#wanted = new Map([...this.#wanted].filter(([item]) => item !== id));
    }
    return result;
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.#client) return Promise.reject(new Error('MS_UNAVAILABLE'));
    return this.#client.request(method, params);
  }

  async register(execution: unknown): Promise<unknown> {
    const agent = this.#sessionOf(execution);
    this.#wanted = new Map([...this.#wanted, [agent.id, 'manual' as const]]);
    return this.#send(agent.id, 'manual');
  }

  async call(execution: unknown, method: string, params: Record<string, unknown>): Promise<unknown> {
    const agent = this.#sessionOf(execution);
    const { title, cwd } = this.#options.describe(agent);
    const result = await this.request(method, { sessionId: agent.id, title, cwd, clientSurface: 'desktop', ...params });
    if (!this.#wanted.has(agent.id)) this.#wanted = new Map([...this.#wanted, [agent.id, 'manual' as const]]);
    return result;
  }

  async unregister(execution: unknown): Promise<unknown> {
    const agent = this.#sessionOf(execution);
    this.#wanted = new Map([...this.#wanted].filter(([id]) => id !== agent.id));
    return this.request('unregister', { sessionId: agent.id });
  }

  autoRegister(enabled: boolean | undefined): Promise<unknown> {
    return this.request('autoRegister', enabled === undefined ? {} : { enabled });
  }

  replyMode(mode: ReplyMode | undefined): Promise<unknown> {
    return this.request('replyMode', mode === undefined ? {} : { mode });
  }

  // Sent at once, so a report made before the session's unregister reaches msd first; a failure only loses that receipt.
  letterTurnEnd(end: LetterTurnEnd): void {
    void this.request('letterTurnEnd', { sessionId: end.sessionId, messageIds: end.letters, reason: end.reason }).catch(() => {});
  }

  list(execution: unknown, params: Record<string, unknown>): Promise<unknown> {
    this.#sessionOf(execution);
    return this.request('list', params);
  }

  #report(event: AutoEvent): void {
    try { this.#options.onAuto?.(event); } catch { /* Diagnostics never change registration. */ }
  }

  // Runs inside the control socket's data handler, so it must not throw: a throw there would drop the connection.
  #sweep(): void {
    if (!this.#autoRegister) return;
    let agents: DshAgent[];
    try { agents = [...this.#options.listAgents()]; } catch { this.#report({ kind: 'failed', code: 'AGENTS_UNAVAILABLE' }); return; }
    this.#report({ kind: 'listed', count: agents.length });
    for (const agent of agents) this.agentCreated(agent);
  }

  agentCreated(agent: DshAgent): void {
    try { this.#bind({ agent }); } catch { if (this.#autoRegister) this.#report({ kind: 'skipped' }); return; }
    if (!this.#autoRegister || this.#wanted.has(agent.id)) return;
    this.#wanted = new Map([...this.#wanted, [agent.id, 'auto' as const]]);
    void this.#send(agent.id, 'auto').then(
      result => this.#report({ kind: (result as { registered?: unknown } | null)?.registered === true ? 'registered' : 'refused' }),
      error => {
        // A failed attempt leaves nothing wanted behind, so the next sweep or agent event tries again.
        if (this.#wanted.get(agent.id) === 'auto') this.#wanted = new Map([...this.#wanted].filter(([id]) => id !== agent.id));
        this.#report({ kind: 'failed', code: codeOf(error) });
      });
  }

  agentDisposed(agent: Readonly<{ id: string }>): void {
    if (!this.#wanted.has(agent.id)) return;
    this.#report({ kind: 'disposed' });
    this.#wanted = new Map([...this.#wanted].filter(([id]) => id !== agent.id));
    void this.request('unregister', { sessionId: agent.id }).catch(() => {});
  }

  close(): void {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#client?.close(); this.#client = undefined; this.#replyMode = null; this.#actPreset = null;
  }
}

export function createDshDaemonClient(options: DaemonClientOptions) {
  const client = new DaemonClient(options);
  return Object.freeze({ start: () => client.start(), close: () => client.close(),
    whenAttached: client.whenAttached, attached: () => client.attached,
    register: (execution: unknown) => client.register(execution),
    unregister: (execution: unknown) => client.unregister(execution),
    autoRegister: (enabled: boolean | undefined) => client.autoRegister(enabled),
    replyMode: (mode: ReplyMode | undefined) => client.replyMode(mode), knownReplyMode: () => client.knownReplyMode,
    letterTurnEnd: (end: LetterTurnEnd) => client.letterTurnEnd(end),
    knownActPreset: () => client.knownActPreset,
    call: (execution: unknown, method: string, params: Record<string, unknown>) => client.call(execution, method, params),
    list: (execution: unknown, params: Record<string, unknown>) => client.list(execution, params),
    agentCreated: (agent: DshAgent) => client.agentCreated(agent),
    agentDisposed: (agent: Readonly<{ id: string }>) => client.agentDisposed(agent) });
}
export type DshDaemonClient = ReturnType<typeof createDshDaemonClient>;
