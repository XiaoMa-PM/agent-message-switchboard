// INPUT: Epoch bindings, live guards and fixed CLI or owned App profile Skill events.
// OUTPUT: Pre expectations and single successful-Post reads/dispatch with bounded whole directory snapshots and compact receipts.
// POS: Pure Claude channel; no OS authentication, hook permission decision or IPC transport.
import { type EpochBinding } from '../adapters/claude/session-epoch.ts';
import { type SendRequest, type ReplyRequest, type Receipt } from '../protocol/message.ts';
import { parseSkillInvocation, assertAppSkillProfile, type AppSkillProfile, type BridgeRequest, type SkillInvocation } from './skill-request.ts';
import { assertClaudeDirectoryOutputCapacity } from './hook-output.ts';
import { parseSessionDirectoryResult, type SessionDirectoryResult } from '../registry/session-view.ts';
import { encodeIpcFrame } from './ipc-frame.ts';

export type ClaudeChannelConnection = Readonly<{ connect: (targetSessionId: string) => Promise<string>;
  send: (request: SendRequest) => Promise<Receipt>; reply: (request: ReplyRequest) => Promise<Receipt> }>;
export type ClaudeChannelOptions = Readonly<{ verify: (binding: EpochBinding) => Promise<void>;
  assertCurrent: (binding: EpochBinding) => undefined; assertOpen: () => void;
  beforeDispatch: (binding: EpochBinding, request: BridgeRequest) => void;
  getConnection: (binding: EpochBinding) => ClaudeChannelConnection }>;
export type PreparedResult = Readonly<{ prepared: true }>;
export type ClaudeChannelResult = SessionDirectoryResult | Readonly<{ linkId: string; targetSessionId: string }>
  | Readonly<{ receipt: Readonly<{ messageId: string; state: Receipt['state']; transport: Receipt['transport'];
    sequence: number; linkId: string; targetSessionId: string }>; deliveryNote: string }>;

export const CLAUDE_DELIVERY_NOTES = Object.freeze({
  dispatched: '宿主已确认入队；不代表模型已读或任务完成。不要自动重发。',
  written: '已记录本机写入证据；未确认宿主受理、已读或完成。不要自动重发。',
  unknown: '没有已确认的本机写入证据；原 messageId 重放不会再次派发。先核对目标和原结果；不要自动换 ID 重试。',
});
type DirectoryReader = Readonly<{ read: () => Promise<unknown> }>;
type Expectation = Readonly<{ binding: EpochBinding; invocation: SkillInvocation;
  directory: DirectoryReader | null; result?: Promise<ClaudeChannelResult> }>;

function compactReceipt(receipt: Receipt): ClaudeChannelResult {
  const deliveryNote = receipt.state === 'dispatched' ? CLAUDE_DELIVERY_NOTES.dispatched
    : receipt.transport === 'written' ? CLAUDE_DELIVERY_NOTES.written : CLAUDE_DELIVERY_NOTES.unknown;
  return Object.freeze({ receipt: Object.freeze({ messageId: receipt.messageId,
    state: receipt.state, transport: receipt.transport, sequence: receipt.envelope.sequence,
    linkId: receipt.envelope.linkId, targetSessionId: receipt.envelope.recipient.nativeSessionId }), deliveryNote });
}

class ClaudeChannel {
  #options: ClaudeChannelOptions;
  #parser: (value: unknown) => SkillInvocation;
  #directory: DirectoryReader | null = null;
  #expectations = new Map<string, Expectation>();

  constructor(options: ClaudeChannelOptions, parser = parseSkillInvocation) {
    this.#options = Object.freeze({ ...options }); this.#parser = parser;
  }

  #check(binding: EpochBinding): void {
    try { this.#options.assertOpen(); this.#options.assertCurrent(binding); }
    catch { throw new Error('CLAUDE_CHANNEL_UNAVAILABLE'); }
  }

  async #ready(binding: EpochBinding): Promise<void> {
    try { this.#check(binding); await this.#options.verify(binding); this.#check(binding); }
    catch { throw new Error('CLAUDE_CHANNEL_UNAVAILABLE'); }
  }

  #previous(key: string, binding: EpochBinding, invocation: SkillInvocation): Expectation | undefined {
    this.#check(binding);
    const previous = this.#expectations.get(key);
    if (previous && (previous.binding !== binding || previous.invocation.originalArgs !== invocation.originalArgs)) {
      throw new Error('SKILL_INVOCATION_CONFLICT');
    }
    return previous;
  }

  async #read(binding: EpochBinding, payload: unknown, event: SkillInvocation['event']) {
    await this.#ready(binding);
    const invocation = this.#parser(payload);
    if (invocation.event !== event) throw new Error('INVALID_SKILL_INVOCATION');
    if (invocation.sessionId !== binding.nativeSessionId) throw new Error('SKILL_SOURCE_MISMATCH');
    const key = JSON.stringify([binding.epoch, invocation.toolUseId]);
    return Object.freeze({ key, invocation });
  }

  async pre(binding: EpochBinding, payload: unknown): Promise<PreparedResult> {
    const { key, invocation } = await this.#read(binding, payload, 'PreToolUse');
    const previous = this.#previous(key, binding, invocation);
    if (!previous) {
      this.#expectations = new Map([...this.#expectations, [key, Object.freeze({ binding, invocation, directory: this.#directory })]]);
    }
    return Object.freeze({ prepared: true });
  }

  post(binding: EpochBinding, payload: unknown): Promise<ClaudeChannelResult> {
    return this.#read(binding, payload, 'PostToolUse').then(({ key, invocation }) => {
      const previous = this.#previous(key, binding, invocation);
      if (!previous) throw new Error('SKILL_PRE_MISSING');
      if (invocation.request.operation === 'list' && previous.directory !== this.#directory) {
        throw new Error('METADATA_QUERY_UNAVAILABLE');
      }
      if (previous.result) return previous.result;
      const result = Promise.resolve().then(() => this.#dispatch(binding, previous.invocation.request, previous.directory));
      this.#expectations = new Map([...this.#expectations, [key, Object.freeze({ ...previous, result })]]);
      return result;
    });
  }

  attachDirectory(read: () => Promise<unknown>): () => void {
    this.#options.assertOpen();
    if (this.#directory || typeof read !== 'function') throw new Error('METADATA_QUERY_UNAVAILABLE');
    const owner = Object.freeze({ read }); this.#directory = owner;
    return () => { if (this.#directory === owner) this.#directory = null; };
  }

  async #queryDirectory(binding: EpochBinding, owner: DirectoryReader | null): Promise<SessionDirectoryResult> {
    if (!owner || this.#directory !== owner) throw new Error('METADATA_QUERY_UNAVAILABLE');
    this.#check(binding);
    let result: SessionDirectoryResult;
    try { result = parseSessionDirectoryResult(await owner.read(), 'dsh'); }
    catch { throw new Error('METADATA_QUERY_FAILED'); }
    await this.#ready(binding);
    this.#check(binding);
    if (this.#directory !== owner) throw new Error('METADATA_QUERY_UNAVAILABLE');
    assertClaudeDirectoryOutputCapacity(result);
    return result;
  }

  async #invoke(connection: ClaudeChannelConnection, request: Exclude<BridgeRequest, { operation: 'list' }>): Promise<ClaudeChannelResult> {
    try {
      if (request.operation === 'connect') {
        return Object.freeze({ linkId: await connection.connect(request.targetSessionId), targetSessionId: request.targetSessionId });
      }
      if (request.operation === 'send') {
        return compactReceipt(await connection.send(Object.freeze({ schemaVersion: 1,
          messageId: request.messageId, linkId: request.linkId, body: request.body })));
      }
      return compactReceipt(await connection.reply(Object.freeze({ schemaVersion: 1,
        messageId: request.messageId, inReplyTo: request.inReplyTo, body: request.body })));
    } catch { throw new Error('CLAUDE_CHANNEL_DELIVERY_UNKNOWN'); }
  }

  async #dispatch(binding: EpochBinding, request: BridgeRequest, directory: DirectoryReader | null): Promise<ClaudeChannelResult> {
    await this.#ready(binding);
    if (request.operation === 'list') return this.#queryDirectory(binding, directory);
    try { this.#options.beforeDispatch(binding, request); }
    catch (error) {
      const code = error instanceof Error && error.message === 'IPC_FRAME_TOO_LARGE'
        ? 'IPC_FRAME_TOO_LARGE' : 'CLAUDE_CHANNEL_PREFLIGHT_FAILED';
      throw new Error(code);
    }
    await this.#ready(binding);
    let connection: ClaudeChannelConnection;
    try { connection = this.#options.getConnection(binding); }
    catch { throw new Error('CLAUDE_CHANNEL_DELIVERY_UNKNOWN'); }
    await this.#ready(binding);
    const result = await this.#invoke(connection, request);
    await this.#ready(binding);
    try { encodeIpcFrame(result); }
    catch { throw new Error('CLAUDE_CHANNEL_DELIVERY_UNKNOWN'); }
    return result;
  }
}

export type ClaudeChannelApi = Readonly<{
  attachDirectory: (read: () => Promise<unknown>) => () => void;
  pre: (binding: EpochBinding, payload: unknown) => Promise<PreparedResult>;
  post: (binding: EpochBinding, payload: unknown) => Promise<ClaudeChannelResult> }>;

function exposeChannel(channel: ClaudeChannel): ClaudeChannelApi {
  return Object.freeze({ attachDirectory: (read: () => Promise<unknown>) => channel.attachDirectory(read),
    pre: (binding: EpochBinding, payload: unknown) => channel.pre(binding, payload),
    post: (binding: EpochBinding, payload: unknown) => channel.post(binding, payload) });
}

export function createClaudeChannel(options: ClaudeChannelOptions): ClaudeChannelApi {
  return exposeChannel(new ClaudeChannel(options));
}

export function createAppClaudeChannel(options: ClaudeChannelOptions, profile: AppSkillProfile): ClaudeChannelApi {
  assertAppSkillProfile(profile);
  return exposeChannel(new ClaudeChannel(options, profile.parseInvocation));
}
