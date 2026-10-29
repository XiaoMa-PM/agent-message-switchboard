// INPUT: MCP _meta.threadId, tool arguments, owner pid and Codex home, the msd adapter channel (with act preset), hook trust.
// OUTPUT: createCodexBridge (lock-verified tools, $ms-* hook commands, reply-mode line, act hook tools, deliver results), LETTER_PREFIXES.
// POS: Codex side of one msd adapter instance (one per Codex MCP process); the model never names its own session.
import { openMsdChannel, type MsdChannel, type MsdEvent } from './msd-channel.ts';
import { deliveryOf, HARNESS_NAMES, parseInboundText } from '../../protocol/inbound-header.ts';
import { deliverReceiptToCodexThread, deliverToCodexThread, type DeliveryDeps, type DeliveryResult } from './delivery.ts';
import { type PushOutcome } from '../../protocol/message.ts';
import { holdsWriterLock, parseThreadId, type ClientSurface } from './thread-owner.ts';
import { autoReceipt, autoUsageText, blockReason, codexFailureText, notRegisteredText, parseCodexCommand, registeredText,
  replyReceipt, replyUsageText, unregisteredText, type CodexCommand } from './commands.ts';
import { autoRegisterText, parseAutoInput } from '../../protocol/auto-register-text.ts';
import { BODY_HAS_REPLY_MODE, BODY_HAS_REPLY_MODE_NOTE, isReplyMode, parseReplyInput, replyModeLine, replyModeText, type ReplyMode }
  from '../../protocol/reply-mode-text.ts';
import { isActPreset, type ActPreset } from '../../protocol/peer-tiers.ts';
import { createCodexAct, type HookOutput, type TurnLetters } from './act-gate.ts';

export type BridgeDeps = DeliveryDeps & Readonly<{ socketPath: string; surface: ClientSurface; cwd: string;
  instanceId: string; projectOf: (cwd: string) => Promise<string | null>; home: string; hooksTrusted: () => Promise<boolean>;
  reconnectMs?: number; letterTimeoutMs?: number }>;
export type ToolResult = Readonly<{ isError: boolean; value: unknown }>;
export type CodexBridge = Readonly<{ call: (name: string, args: unknown, meta: unknown) => Promise<ToolResult>; start: () => void;
  close: () => void }>;
type Shape = Readonly<{ required: readonly string[]; optional: readonly string[] }>;
type Registration = Readonly<{ cwd: string; mode: 'manual' | 'auto' }>;

const SHAPES: Readonly<Record<string, Shape>> = Object.freeze({
  router_register: { required: [], optional: [] },
  router_unregister: { required: [], optional: [] },
  router_list_sessions: { required: [], optional: ['harness', 'project'] },
  router_send: { required: ['harness', 'target', 'body'], optional: ['project', 'messageId'] },
  router_reply: { required: ['inReplyTo', 'body'], optional: ['messageId'] },
  router_session_start: { required: [], optional: ['source', 'cwd'] },
  router_prompt_command: { required: ['prompt', 'turn_id', 'permission_mode'], optional: [] },
  router_turn_end: { required: ['turn_id', 'hook_event_name'], optional: [] },
});
const SILENT = new Set(['router_session_start']);
const QUIET: ToolResult = Object.freeze({ isError: false, value: undefined });
const UNKNOWN: PushOutcome = Object.freeze({ state: 'delivery-unknown', transport: null });
const NOT_HERE: DeliveryResult = Object.freeze({ outcome: UNKNOWN, error: 'TARGET_OFFLINE' });
const FAILED: DeliveryResult = Object.freeze({ outcome: UNKNOWN, error: null });
const CODE = /^[A-Z][A-Z0-9_]+$/;
// Letters reach Codex from the other two harnesses only; a Codex peer would use Codex's own tools.
export const LETTER_PREFIXES: readonly string[] = Object.freeze([HARNESS_NAMES['claude-code'], HARNESS_NAMES.dsh]
  .map(name => `来源：${name} | Agent Message Switchboard`));
// Well inside the hook's 10-second timeout, so a slow msd never turns into a Hook failed on a letter.
const LETTER_TIMEOUT_MS = 3000;
// Codex's hook permission_mode for approval never: no call can be put to the user, so an act letter reads as direct.
// Full access with approvals on stays act.
const NEVER = 'bypassPermissions';
// msd's letterTurnEnd takes at most this many letters at a time (adapter-channel MAX_TURN_LETTERS).
const TURN_LETTERS = 64;
// A code the model can fix itself carries a note (a body holding a mode line).
const failed = (code: string): ToolResult => Object.freeze({ isError: true, value: Object.freeze({ error: code,
  ...(code === BODY_HAS_REPLY_MODE ? { note: BODY_HAS_REPLY_MODE_NOTE } : {}) }) });
const hookAnswer = (output: HookOutput | undefined): ToolResult => (output === undefined ? QUIET : Object.freeze({ isError: false, value: output }));
const presetOf = (value: unknown): ActPreset | null => {
  const preset = (value as Record<string, unknown> | null)?.actPreset;
  return isActPreset(preset) ? preset : null;
};
const codeOf = (error: unknown) => error instanceof Error && CODE.test(error.message) ? error.message : 'INTERNAL_ERROR';

function toolArgs(shape: Shape, value: unknown): Readonly<Record<string, string>> {
  const args = value ?? {};
  if (typeof args !== 'object' || Array.isArray(args)) throw new Error('INVALID_ARGUMENTS');
  const entries = Object.entries(args);
  const allowed = [...shape.required, ...shape.optional];
  if (entries.some(([key, item]) => !allowed.includes(key) || typeof item !== 'string')
      || shape.required.some(key => !Object.hasOwn(args, key))) throw new Error('INVALID_ARGUMENTS');
  return Object.freeze(Object.fromEntries(entries)) as Readonly<Record<string, string>>;
}

class Bridge {
  #deps: BridgeDeps;
  #channel: Promise<MsdChannel> | null = null;
  #current: MsdChannel | null = null;
  #registered = new Map<string, Registration>();
  #retry: NodeJS.Timeout | null = null;
  #closed = false;
  // Started bridges stay attached; one that is never started connects on its first call and reconnects only for threads.
  #started = false;
  // What msd last said, only while attached; act-gate reads a missing preset as read-only.
  #actPreset: ActPreset | null = null;
  #act;

  constructor(deps: BridgeDeps) {
    this.#deps = deps;
    this.#act = createCodexAct({ preset: () => this.#actPreset, projectOf: deps.projectOf, home: deps.home });
  }

  #connect(): Promise<MsdChannel> {
    if (this.#closed) return Promise.reject(new Error('MS_UNAVAILABLE'));
    this.#channel ??= (async () => {
      const channel = await openMsdChannel(this.#deps.socketPath, event => { void this.#onEvent(event); });
      try { this.#actPreset = presetOf(await channel.request('adapter.attach', { harness: 'codex', instanceId: this.#deps.instanceId })); }
      catch (error) { channel.close(); throw error; }
      // Closed while attaching: never stay attached.
      if (this.#closed) { channel.close(); throw new Error('MS_UNAVAILABLE'); }
      this.#current = channel;
      void channel.closed.then(() => this.#lost(channel));
      return channel;
    })();
    const pending = this.#channel;
    pending.catch(() => { if (this.#channel === pending) this.#channel = null; });
    return pending;
  }

  async #request(method: string, params: Record<string, unknown>): Promise<unknown> {
    return (await this.#connect()).request(method, params);
  }

  #lost(channel: MsdChannel): void {
    if (this.#current !== channel) return;
    this.#current = null; this.#channel = null; this.#actPreset = null;
    if (!this.#closed && (this.#started || this.#registered.size)) this.#schedule();
  }

  // Attach as soon as the MCP process starts, without holding up initialize or any call (the first call waits on the same
  // connection), so msd counts an open Codex session before the user types anything.
  start(): void {
    if (this.#closed || this.#started) return;
    this.#started = true;
    void this.#restore();
  }

  #schedule(): void {
    this.#retry ??= setTimeout(() => { this.#retry = null; void this.#restore(); }, this.#deps.reconnectMs ?? 5000);
    this.#retry.unref();
  }

  // Attach again, then re-register the threads this parent still owns: msd revokes a dropped connection's sessions.
  async #restore(): Promise<void> {
    try {
      await this.#connect();
      for (const [threadId, registration] of this.#registered) {
        if (await this.#owns(threadId)) await this.#register(threadId, registration);
        else this.#registered.delete(threadId);
      }
    } catch { if (!this.#closed) this.#schedule(); }
  }

  #owns(threadId: string): Promise<boolean> {
    return holdsWriterLock(this.#deps.listHolders, this.#deps.codexHome, threadId, this.#deps.ownerPid);
  }

  async #caller(meta: unknown): Promise<string> {
    let threadId: string;
    try { threadId = parseThreadId((meta as Record<string, unknown> | undefined)?.threadId); }
    catch { throw new Error('IDENTITY_UNAVAILABLE'); }
    if (!await this.#owns(threadId)) throw new Error('IDENTITY_MISMATCH');
    return threadId;
  }

  async #register(threadId: string, registration: Registration): Promise<unknown> {
    const result = await this.#request('register', { sessionId: threadId, cwd: registration.cwd,
      clientSurface: this.#deps.surface, mode: registration.mode });
    if ((result as Record<string, unknown> | null)?.registered === true) this.#registered.set(threadId, registration);
    return result;
  }

  async #run(name: string, args: Readonly<Record<string, string>>, threadId: string): Promise<unknown> {
    if (name === 'router_register') return this.#register(threadId, { cwd: this.#deps.cwd, mode: 'manual' });
    if (name === 'router_unregister') return this.#unregister(threadId);
    if (name === 'router_session_start') return this.#register(threadId, { cwd: args.cwd ?? this.#deps.cwd, mode: 'auto' });
    if (name === 'router_list_sessions') return this.#request('list', { ...args });
    // Sending implies the peer may answer: register the caller first so replies have a live address.
    if (!this.#registered.has(threadId)) await this.#register(threadId, { cwd: this.#deps.cwd, mode: 'manual' });
    // msd re-registers implicitly if the session was taken offline meanwhile; give it the same profile.
    const cwd = this.#registered.get(threadId)?.cwd ?? this.#deps.cwd;
    return this.#request(name === 'router_send' ? 'send' : 'reply',
      { sessionId: threadId, ...args, cwd, clientSurface: this.#deps.surface });
  }

  // Revoked threads are not restored after a reconnect; msd keeps the contact and its links.
  async #unregister(threadId: string): Promise<unknown> {
    this.#registered.delete(threadId);
    return this.#request('unregister', { sessionId: threadId });
  }

  async #command(command: CodexCommand, threadId: string): Promise<string> {
    if (command.kind === 'reply') {
      const action = parseReplyInput(command.input, 'codex');
      if (action === null) return replyUsageText();
      const result = await this.#request('replyMode', action === 'status' ? {} : { mode: action }) as Record<string, unknown> | null;
      if (!isReplyMode(result?.replyMode)) throw new Error('INTERNAL_ERROR');
      return replyReceipt(replyModeText('codex', action, result.replyMode, this.#actPreset ?? undefined));
    }
    if (command.kind === 'auto') {
      const action = parseAutoInput(command.input);
      if (action === null) return autoUsageText();
      const result = await this.#request('autoRegister', action === 'status' ? {} : { enabled: action === 'on' }) as Record<string, unknown>;
      const projects = Array.isArray(result?.autoRegisterProjects) ? result.autoRegisterProjects as string[] : [];
      return autoReceipt(autoRegisterText('codex', action, result?.autoRegister === true, projects));
    }
    if (command.kind === 'unregister') {
      const result = await this.#unregister(threadId) as Record<string, unknown> | null;
      return result?.unregistered === true ? unregisteredText(threadId) : notRegisteredText(threadId);
    }
    const before = this.#registered.has(threadId);
    const result = await this.#register(threadId, { cwd: this.#deps.cwd, mode: 'manual' }) as Record<string, unknown> | null;
    if (result?.registered !== true) throw new Error('NOT_REGISTERED');
    return registeredText(before ? 'unchanged' : 'registered', threadId, this.#deps.surface, result.project);
  }

  // A peer letter gets one context line with this harness's reply mode once msd has matched it to a delivery to this thread.
  // Anything short of that (not a letter, not verified, already told, msd absent or slow) adds nothing and never blocks.
  // No writer-lock recheck here: msd's letterMode only answers for a thread this channel holds registered and online, and every
  // registration on this channel passed #owns when it was made (#caller, #restore), so channel membership stands in for the lock.
  async #letterContext(prompt: string, hook: Readonly<Record<string, string>>, meta: unknown): Promise<ToolResult> {
    let threadId: string;
    try { threadId = parseThreadId((meta as Record<string, unknown> | undefined)?.threadId); } catch { return QUIET; }
    const expired = Promise.withResolvers<null>();
    const timer = setTimeout(() => expired.resolve(null), this.#deps.letterTimeoutMs ?? LETTER_TIMEOUT_MS);
    try {
      const result = await Promise.race([this.#request('letterMode', { sessionId: threadId, prompt }), expired.promise]) as
        Record<string, unknown> | null;
      if (!isReplyMode(result?.replyMode)) return QUIET;
      const mode = await this.#letterTurn(result.replyMode, prompt, hook, threadId, expired.promise);
      return Object.freeze({ isError: false, value: Object.freeze({ hookSpecificOutput: Object.freeze({
        hookEventName: 'UserPromptSubmit', additionalContext: replyModeLine(mode) }) }) });
    } catch { return QUIET; } finally { clearTimeout(timer); }
  }

  // Under act the letter's turn stays gated after it is over: a Codex code-mode cell can keep running and calling tools under that
  // turn_id after Stop or Esc, so nothing ends it but act-gate's bound. An untrusted hook never runs, so act
  // also needs every act hook trusted for its current contents; a check that fails or outlasts the letter
  // budget counts as untrusted, and a late answer opens nothing. The messageId is the one msd's letterMode just verified from the
  // same header.
  async #letterTurn(mode: ReplyMode, prompt: string, hook: Readonly<Record<string, string>>, threadId: string,
    expired: Promise<null>): Promise<ReplyMode> {
    if (mode !== 'act') return mode;
    if (hook.permission_mode === NEVER) return 'direct';
    const trusted = await Promise.race([this.#deps.hooksTrusted().catch(() => false), expired.then(() => false)]);
    if (!trusted) return 'direct';
    this.#act.open(threadId, hook.turn_id, parseInboundText(prompt)!.messageId, prompt);
    return 'act';
  }

  // Stop and Interrupt never wait on msd. The letters are taken off the table here, so a repeated Stop reports nothing,
  // and go to msd afterwards; a failure there only means no receipt.
  #turnEnd(raw: unknown, meta: unknown): ToolResult {
    let hook: Readonly<Record<string, string>>;
    let threadId: string;
    try {
      hook = toolArgs(SHAPES.router_turn_end, raw);
      threadId = parseThreadId((meta as Record<string, unknown> | undefined)?.threadId);
    } catch { return QUIET; }
    void this.#report(threadId, this.#act.turnEnded(threadId, hook.turn_id, hook.hook_event_name));
    return QUIET;
  }

  async #report(threadId: string, groups: readonly TurnLetters[]): Promise<void> {
    for (const { reason, messageIds } of groups) {
      for (let start = 0; start < messageIds.length; start += TURN_LETTERS) {
        await this.#request('letterTurnEnd', { sessionId: threadId, messageIds: messageIds.slice(start, start + TURN_LETTERS), reason })
          .catch(() => {});
      }
    }
  }

  // Ordinary prompts return nothing and never reach msd; a typed command always blocks so the model never sees it.
  async #promptCommand(raw: unknown, meta: unknown): Promise<ToolResult> {
    let hook: Readonly<Record<string, string>>;
    try { hook = toolArgs(SHAPES.router_prompt_command, raw); } catch { return QUIET; }
    const prompt = hook.prompt;
    const command = parseCodexCommand(prompt, this.#deps.codexHome);
    if (command === null) return LETTER_PREFIXES.some(prefix => prompt.startsWith(prefix)) ? this.#letterContext(prompt, hook, meta) : QUIET;
    let text: string;
    try { text = await this.#command(command, await this.#caller(meta)); }
    catch (error) { text = codexFailureText(command.kind, codeOf(error)); }
    return Object.freeze({ isError: false, value: blockReason(text) });
  }

  async call(name: string, raw: unknown, meta: unknown): Promise<ToolResult> {
    if (name === 'router_prompt_command') return this.#promptCommand(raw, meta);
    if (name === 'router_pre_tool_use') return hookAnswer(await this.#act.preToolUse(raw));
    if (name === 'router_permission_request') return hookAnswer(this.#act.permissionRequest(raw));
    if (name === 'router_turn_end') return this.#turnEnd(raw, meta);
    const shape = SHAPES[name];
    if (!shape) return failed('UNKNOWN_TOOL');
    try {
      const args = toolArgs(shape, raw);
      const value = await this.#run(name, args, await this.#caller(meta));
      return Object.freeze({ isError: false, value: SILENT.has(name) ? undefined : value });
    } catch (error) {
      return SILENT.has(name) ? Object.freeze({ isError: false, value: undefined }) : failed(codeOf(error));
    }
  }

  async #onEvent(event: MsdEvent): Promise<void> {
    if (event.event === 'config') { this.#actPreset = presetOf(event.data); return; }
    if (event.event === 'receipt') return this.#receipt(event.data);
    if (event.event !== 'deliver') return;
    const data = event.data as Record<string, unknown> | null;
    const envelope = data?.envelope as Record<string, any> | undefined;
    const messageId = envelope?.messageId;
    if (typeof messageId !== 'string') return;
    const threadId = envelope?.recipient?.nativeSessionId;
    let result: DeliveryResult = NOT_HERE;
    if (typeof threadId === 'string' && this.#registered.has(threadId)) {
      const { replyHint, senderLabel } = deliveryOf(data);
      try { result = await deliverToCodexThread(this.#deps, envelope, replyHint, senderLabel); }
      catch { result = FAILED; }
    }
    await this.#request('deliver.result', { messageId, ...result.outcome, ...(result.error ? { error: result.error } : {}) })
      .catch(() => {});
  }

  // A receipt is not a letter: its text starts with no peer prefix, so its prompt never reaches letterMode or opens a turn.
  async #receipt(data: unknown): Promise<void> {
    const { receiptId, sessionId, text } = (data ?? {}) as Record<string, unknown>;
    if (typeof receiptId !== 'string' || typeof sessionId !== 'string' || typeof text !== 'string'
        || !this.#registered.has(sessionId)) return;
    await deliverReceiptToCodexThread(this.#deps, sessionId, receiptId, text).catch(() => {});
  }

  close(): void {
    this.#closed = true;
    if (this.#retry) clearTimeout(this.#retry);
    this.#current?.close();
  }
}

export function createCodexBridge(deps: BridgeDeps): CodexBridge {
  const bridge = new Bridge(deps);
  return Object.freeze({ call: (name: string, args: unknown, meta: unknown) => bridge.call(name, args, meta),
    start: () => bridge.start(), close: () => bridge.close() });
}
