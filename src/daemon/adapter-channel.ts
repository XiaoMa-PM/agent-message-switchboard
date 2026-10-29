// INPUT: One attached control connection (harness + instanceId), the switchboard, auto-register and reply-mode policy and method params.
// OUTPUT: Channel-owned registrations, one-step send/reply, deliver/receipt/config events, autoRegister, replyMode, letterMode, letterTurnEnd.
// POS: msd side of DSH/Codex plugin adapters; same-UID trusted, sessions scoped to the attaching connection.
import { isMessageId, parsePushOutcome, type Envelope, type Harness, type PushOutcome } from '../protocol/message.ts';
import { type ActPreset } from '../protocol/peer-tiers.ts';
import { isReceiptReason } from '../protocol/receipt-text.ts';
import { isReplyMode, type ReplyMode } from '../protocol/reply-mode-text.ts';
import { exactParams } from './control-protocol.ts';
import { type ControlConnection } from './control-server.ts';
import { type Delivery, type Notice } from './directory.ts';
import { parseHarness, type ClientSurface, type Switchboard } from './switchboard.ts';

type Pending = Readonly<{ resolve: (outcome: PushOutcome) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>;
const PROFILE = ['title', 'cwd', 'clientSurface'] as const;
type Params = Readonly<Record<string, unknown>>;
export type AutoPolicy = Readonly<{ enabled: (harness: Harness) => boolean; allows: (project: string | null) => boolean;
  projects: () => readonly string[]; set: (harness: Harness, enabled: boolean) => Promise<void> }>;
export type ReplyPolicy = Readonly<{ mode: (harness: Harness) => ReplyMode; set: (harness: Harness, mode: ReplyMode) => Promise<void> }>;
export type ChannelOptions = Readonly<{ board: Switchboard; auto: AutoPolicy; reply: ReplyPolicy;
  projectOf: (cwd: string | null) => Promise<string | null>; timeoutMs?: number }>;
export const DELIVERY_TIMEOUT_MS = 30_000;
export const MAX_TURN_LETTERS = 64;

function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('INVALID_REQUEST');
  return value;
}

function optionalText(params: Params, name: string): string | null {
  const value = params[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error('INVALID_REQUEST');
  return value;
}

function pick(params: Params, names: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(names.filter(name => params[name] !== undefined).map(name => [name, params[name]]));
}

export class AdapterChannel {
  readonly harness: Harness;
  readonly instanceId: string;
  #connection: ControlConnection;
  #options: ChannelOptions;
  #sessions = new Map<string, string>();
  #pending = new Map<string, Pending>();

  constructor(connection: ControlConnection, harness: Harness, instanceId: string, options: ChannelOptions) {
    this.#connection = connection; this.harness = harness; this.instanceId = instanceId; this.#options = options;
  }

  #surface(params: Params): ClientSurface {
    const value = params.clientSurface ?? (this.harness === 'dsh' ? 'desktop' : 'cli');
    if (value !== 'cli' && value !== 'desktop') throw new Error('INVALID_REQUEST');
    return value;
  }

  #sender(params: Params) {
    const sessionId = text(params.sessionId);
    const generation = this.#sessions.get(sessionId) ?? (() => { throw new Error('NOT_REGISTERED'); })();
    return Object.freeze({ harness: this.harness, sessionId, generation });
  }

  #push(frame: Envelope, delivery: Delivery): Promise<PushOutcome> {
    if (!this.#connection.isOpen()) return Promise.reject(new Error('TARGET_OFFLINE'));
    const deferred = Promise.withResolvers<PushOutcome>();
    const timer = setTimeout(() => {
      this.#pending = new Map([...this.#pending].filter(([id]) => id !== frame.messageId));
      deferred.reject(new Error('DELIVERY_TIMEOUT'));
    }, this.#options.timeoutMs ?? DELIVERY_TIMEOUT_MS);
    this.#pending = new Map([...this.#pending, [frame.messageId, Object.freeze({ resolve: deferred.resolve, reject: deferred.reject, timer })]]);
    this.#connection.emit('deliver', { envelope: frame, replyHint: delivery.replyHint, senderLabel: delivery.senderLabel });
    return deferred.promise;
  }

  // A receipt wants no result: it is emitted while the connection is open and otherwise dropped, never queued.
  async #notice(sessionId: string, notice: Notice): Promise<void> {
    if (this.#connection.isOpen()) this.#connection.emit('receipt', { receiptId: notice.receiptId, sessionId, text: notice.text });
  }

  async #attachSession(sessionId: string, params: Params, mode: 'manual' | 'auto') {
    const surface = this.#surface(params); const title = optionalText(params, 'title'); const cwd = optionalText(params, 'cwd');
    const project = await this.#options.projectOf(cwd);
    if (mode === 'auto' && (!this.#options.auto.enabled(this.harness) || !this.#options.auto.allows(project))) {
      return Object.freeze({ harness: this.harness, sessionId, registered: false, project });
    }
    const online = this.#options.board.register({ harness: this.harness, sessionId, clientSurface: surface, title, cwd, project,
      push: (frame, delivery) => this.#push(frame, delivery),
      verify: async () => { if (!this.#connection.isOpen()) throw new Error('TARGET_OFFLINE'); },
      notice: notice => this.#notice(sessionId, notice) });
    this.#sessions = new Map([...this.#sessions, [sessionId, online.generation]]);
    return Object.freeze({ harness: this.harness, sessionId, registered: true, project });
  }

  async #register(params: Params) {
    exactParams(params, ['sessionId'], [...PROFILE, 'mode']);
    if (params.mode !== undefined && params.mode !== 'manual' && params.mode !== 'auto') throw new Error('INVALID_REQUEST');
    return this.#attachSession(text(params.sessionId), params, params.mode === 'auto' ? 'auto' : 'manual');
  }

  async #caller(params: Params) {
    const sessionId = text(params.sessionId);
    if (!this.#sessions.has(sessionId) || !this.#options.board.online({ harness: this.harness, sessionId })) {
      await this.#attachSession(sessionId, params, 'manual');
    }
    return this.#sender(params);
  }

  #unregister(params: Params) {
    exactParams(params, ['sessionId']);
    const sessionId = text(params.sessionId);
    const generation = this.#sessions.get(sessionId);
    this.#sessions = new Map([...this.#sessions].filter(([id]) => id !== sessionId));
    return Object.freeze({ unregistered: generation !== undefined
      && this.#options.board.unregister({ harness: this.harness, sessionId }, generation) });
  }

  #list(params: Params) {
    exactParams(params, [], ['harness', 'project']);
    const project = params.project === undefined ? undefined : text(params.project);
    if (params.harness === undefined) return this.#options.board.list({ project }).filter(row => row.harness !== this.harness);
    const harness = parseHarness(params.harness);
    if (harness === this.harness) throw new Error('USE_NATIVE_TOOLS');
    return this.#options.board.list({ harness, project });
  }

  #result(params: Params) {
    exactParams(params, ['messageId', 'state', 'transport'], ['error']);
    const pending = this.#pending.get(text(params.messageId));
    if (!pending) throw new Error('UNKNOWN_DELIVERY');
    let outcome: PushOutcome;
    try { outcome = parsePushOutcome({ state: params.state, transport: params.transport }); }
    catch { throw new Error('INVALID_REQUEST'); }
    if (params.error !== undefined && (params.error !== 'TARGET_OFFLINE' || outcome.state !== 'delivery-unknown'
        || outcome.transport !== null)) throw new Error('INVALID_REQUEST');
    clearTimeout(pending.timer);
    this.#pending = new Map([...this.#pending].filter(([id]) => id !== params.messageId));
    if (params.error === 'TARGET_OFFLINE') pending.reject(new Error('TARGET_OFFLINE'));
    else pending.resolve(outcome);
    return Object.freeze({});
  }

  async #autoRegister(params: Params) {
    exactParams(params, [], ['enabled']);
    if (params.enabled !== undefined) {
      if (typeof params.enabled !== 'boolean') throw new Error('INVALID_REQUEST');
      await this.#options.auto.set(this.harness, params.enabled);
    }
    return Object.freeze({ autoRegister: this.#options.auto.enabled(this.harness), autoRegisterProjects: this.#options.auto.projects() });
  }

  async #replyMode(params: Params) {
    exactParams(params, [], ['mode']);
    if (params.mode !== undefined) {
      if (!isReplyMode(params.mode)) throw new Error('INVALID_REQUEST');
      await this.#options.reply.set(this.harness, params.mode);
    }
    return Object.freeze({ replyMode: this.#options.reply.mode(this.harness) });
  }

  // Unlike send/reply this never registers: a letter can only have reached a session this channel already holds online.
  #letterMode(params: Params) {
    exactParams(params, ['sessionId', 'prompt']);
    const sessionId = text(params.sessionId);
    if (typeof params.prompt !== 'string') throw new Error('INVALID_REQUEST');
    const recipient = { harness: this.harness, sessionId };
    if (!this.#sessions.has(sessionId) || !this.#options.board.online(recipient)) throw new Error('LETTER_NOT_VERIFIED');
    this.#options.board.verifyLetter(recipient, params.prompt);
    return Object.freeze({ replyMode: this.#options.reply.mode(this.harness) });
  }

  // Same scope as letterMode and the same same-UID trust: a forged call can at most bring a sender's receipt early.
  #letterTurnEnd(params: Params) {
    exactParams(params, ['sessionId', 'messageIds', 'reason']);
    const sessionId = text(params.sessionId);
    const ids: unknown = params.messageIds;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_TURN_LETTERS || !ids.every(isMessageId)
        || !isReceiptReason(params.reason)) throw new Error('INVALID_REQUEST');
    const recipient = { harness: this.harness, sessionId };
    if (!this.#sessions.has(sessionId) || !this.#options.board.online(recipient)) throw new Error('LETTER_NOT_VERIFIED');
    return Object.freeze({ outcomes: this.#options.board.letterTurnEnded(recipient, Object.freeze([...ids]), params.reason) });
  }

  async handle(method: string, params: Params): Promise<unknown> {
    if (method === 'register') return this.#register(params);
    if (method === 'autoRegister') return this.#autoRegister(params);
    if (method === 'replyMode') return this.#replyMode(params);
    if (method === 'letterMode') return this.#letterMode(params);
    if (method === 'letterTurnEnd') return this.#letterTurnEnd(params);
    if (method === 'unregister') return this.#unregister(params);
    if (method === 'list') return this.#list(params);
    if (method === 'deliver.result') return this.#result(params);
    if (method === 'send') {
      exactParams(params, ['sessionId', 'harness', 'target', 'body'], ['project', 'messageId', ...PROFILE]);
      return this.#options.board.send(await this.#caller(params), pick(params, ['harness', 'target', 'project', 'messageId', 'body']));
    }
    if (method === 'reply') {
      exactParams(params, ['sessionId', 'inReplyTo', 'body'], ['messageId', ...PROFILE]);
      return this.#options.board.reply(await this.#caller(params), pick(params, ['inReplyTo', 'messageId', 'body']));
    }
    throw new Error('UNKNOWN_METHOD');
  }

  emitConfig(autoRegister: boolean, autoRegisterProjects: readonly string[], replyMode: ReplyMode, actPreset: ActPreset): void {
    if (this.#connection.isOpen()) this.#connection.emit('config', { autoRegister, autoRegisterProjects, replyMode, actPreset });
  }

  close(): void {
    for (const [sessionId, generation] of this.#sessions) this.#options.board.unregister({ harness: this.harness, sessionId }, generation);
    this.#sessions = new Map();
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('TARGET_OFFLINE')); }
    this.#pending = new Map();
  }
}
