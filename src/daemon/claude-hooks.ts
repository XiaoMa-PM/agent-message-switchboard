// INPUT: Owned-broker daily hook requests, signed live inspect, Python/wrapper pins, auto-register and reply-mode policy.
// OUTPUT: Claude registration lifecycle, one-shot Skill requests, /ms:auto and /ms:reply switches, letter reply mode, act gating.
// POS: msd Claude adapter; identity = kernel peer + Anthropic code signature and ancestry (claude-identity), same-UID trust otherwise.
import { type BinaryPin, type InspectSigned, type SignedSnapshot } from '../adapters/claude/peer-identity.ts';
import { captureAppSocket, verifyAppSocket, type AppSocketPin } from '../bridge/app-socket.ts';
import { type StdioRequest } from '../bridge/stdio-rpc.ts';
import { type DailyHookResult } from '../bridge/hook-output.ts';
import { autoRegisterText, parseAutoInput } from '../protocol/auto-register-text.ts';
import { parseReplyInput, REPLY_COMMANDS, replyModeLine, replyModeText, type ReplyMode } from '../protocol/reply-mode-text.ts';
import { createClaudeAct, type ActOptions } from './claude-act.ts';
import { type Endpoint } from '../protocol/message.ts';
import { resolveClaudeIdentity, type ClaudeIdentity } from './claude-identity.ts';
import { type NoticePush, type Push } from './directory.ts';
import { blockOutput, DAILY_COMMANDS, dailyAutoInput, dailyReplyInput, directoryContext, errorContext, isDailySkill, isLetterPrompt,
  letterOutput, parseDailyRequest, parseSkillCall, PASS, postOutput, sendContext, type DailyRequest } from './claude-skill.ts';
import { type ClientSurface, type Switchboard } from './switchboard.ts';

type Options = Readonly<{ board: Switchboard; inspect: InspectSigned; wrapperPins: () => readonly BinaryPin[]; python: BinaryPin;
  auto: Readonly<{ enabled: () => boolean; allows: (project: string | null) => boolean; projects: () => readonly string[];
    set: (enabled: boolean) => Promise<void> }>; reply: Readonly<{ mode: () => ReplyMode; set: (mode: ReplyMode) => Promise<void> }>;
  makePush: (endpoint: Endpoint, socketPath: string) => Push; makeNotice: (sessionId: string, socketPath: string) => NoticePush;
  projectOf: (cwd: string | null) => Promise<string | null>; act: ActOptions }>;
type Identity = ClaudeIdentity;
type ClaudeRecord = Readonly<{ sessionId: string; identity: SignedSnapshot; socket: AppSocketPin; generation: string }>;
type Hook = Readonly<Record<string, unknown>>;
type Expectation = Readonly<{ originalArgs: string; generation: string | null; result?: Promise<unknown> }>;
type Profile = Readonly<{ surface: ClientSurface; title: string | null; cwd: string | null; project: string | null }>;
const SID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const processKey = (row: SignedSnapshot) => JSON.stringify([row.pid, row.pidVersion, row.uniqueId]);
const code = (error: unknown) => error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'INTERNAL_ERROR';
const ref = (sessionId: string) => Object.freeze({ harness: 'claude-code' as const, sessionId });
const OFFLINE_PUSH = new Set(['INVALID_SOCKET', 'INBOX_WRITE_FAILED']);
const registeredLine = (state: 'registered' | 'unchanged', sessionId: string, surface: ClientSurface, project: string | null | undefined) =>
  `${state === 'registered' ? '已登记' : '已登记（无变化）'} Switchboard：claude-code 会话 ${sessionId}`
  + `（${surface === 'cli' ? 'CLI' : 'App'}${project ? `，项目 ${project}` : ''}）。其他 Harness 现在可以联系本会话`;
const failure = (error: unknown) => code(error) === 'UNKNOWN_CLAUDE_BINARY'
  ? 'UNKNOWN_CLAUDE_BINARY）：调用方不是有效的 Anthropic 签名 Claude Code，或调用链里有未识别的程序' : code(error) + '）';

function plain(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_HOOK_EVENT');
  return value as Record<string, unknown>;
}

// profile daily-act comes only from the act PreToolUse hook, which runs only inside a marked letter turn; daily-turn only from the
// Stop and StopFailure hooks of a marked session.
const PROFILES: ReadonlySet<unknown> = new Set(['daily', 'daily-act', 'daily-turn']);
export function parseDailyHook(value: unknown): Readonly<{ hook: Hook; messagingSocket: string | null; act: boolean; turn: boolean }> {
  const raw = plain(value);
  if (Object.keys(raw).length !== 3 || !PROFILES.has(raw.profile) || !Object.hasOwn(raw, 'hook')
      || !Object.hasOwn(raw, 'messagingSocket')) throw new Error('INVALID_HOOK_EVENT');
  const hook = plain(raw.hook);
  if (typeof hook.hook_event_name !== 'string' || typeof hook.session_id !== 'string' || !SID.test(hook.session_id)
      || (raw.messagingSocket !== null && typeof raw.messagingSocket !== 'string')) throw new Error('INVALID_HOOK_EVENT');
  return Object.freeze({ hook: Object.freeze({ ...hook }), messagingSocket: raw.messagingSocket as string | null, act: raw.profile === 'daily-act',
    turn: raw.profile === 'daily-turn' });
}

class ClaudeHooks {
  #options: Options;
  #records = new Map<string, ClaudeRecord>();
  #expectations = new Map<string, Expectation>();
  #act: ReturnType<typeof createClaudeAct>;

  constructor(options: Options) {
    this.#options = options;
    // Only the current registered session settles; like the act gate, there is no signature check per signal.
    this.#act = createClaudeAct({ ...options.act, projectOf: options.projectOf, settle: (sessionId, letters, reason) => {
      if (this.#current(sessionId)) options.board.letterTurnEnded(ref(sessionId), letters, reason);
    } });
  }

  #identify(peer: StdioRequest['peer']): Promise<Identity> {
    return resolveClaudeIdentity(peer, this.#options.inspect, [this.#options.python, ...this.#options.wrapperPins()]);
  }

  #current(sessionId: string): ClaudeRecord | undefined {
    const record = this.#records.get(sessionId);
    if (record && this.#options.board.online(ref(sessionId))?.generation === record.generation) return record;
    if (record) this.#records = new Map([...this.#records].filter(([id]) => id !== sessionId));
    return undefined;
  }

  #retire(sessionId: string): boolean {
    const record = this.#current(sessionId);
    this.#records = new Map([...this.#records].filter(([id]) => id !== sessionId));
    return !!record && this.#options.board.unregister(ref(sessionId), record.generation);
  }

  async #live(identity: SignedSnapshot, socket: AppSocketPin): Promise<void> {
    const current = await this.#options.inspect(identity.pid);
    if (!same(current, identity)) throw new Error('TARGET_OFFLINE');
    verifyAppSocket(socket);
  }

  #attach(sessionId: string, identity: SignedSnapshot, socket: AppSocketPin, profile: Profile): void {
    let inbox: Push = async () => { throw new Error('TARGET_OFFLINE'); };
    const push: Push = async (frame, delivery) => {
      try { return await inbox(frame, delivery); }
      catch (error) { throw OFFLINE_PUSH.has(code(error)) ? new Error('TARGET_OFFLINE') : error; }
    };
    const online = this.#options.board.register({ ...ref(sessionId), clientSurface: profile.surface, title: profile.title,
      cwd: profile.cwd, project: profile.project, binding: { identity, socket }, push,
      verify: () => this.#live(identity, socket), notice: this.#options.makeNotice(sessionId, socket.path) });
    inbox = this.#options.makePush(online.endpoint, socket.path);
    this.#records = new Map([...this.#records, [sessionId, Object.freeze({ sessionId, identity, socket, generation: online.generation })]]);
  }

  async #profile(hook: Hook, surface: ClientSurface): Promise<Profile> {
    const previous = this.#options.board.contact(ref(hook.session_id as string));
    const title = typeof hook.session_title === 'string' && hook.session_title.trim() ? hook.session_title : previous?.title ?? null;
    const cwd = typeof hook.cwd === 'string' && hook.cwd ? hook.cwd : previous?.cwd ?? null;
    return Object.freeze({ surface, title, cwd, project: await this.#options.projectOf(cwd) });
  }

  async #register(identity: Identity, hook: Hook, socketPath: string | null, auto: boolean): Promise<'registered' | 'unchanged' | 'skipped'> {
    const sessionId = hook.session_id as string;
    if (socketPath === null) throw new Error('MESSAGING_SOCKET_UNAVAILABLE');
    const socket = captureAppSocket(socketPath);
    const existing = this.#current(sessionId);
    if (existing && same(existing.identity, identity.snapshot) && same(existing.socket, socket)) return 'unchanged';
    const profile = await this.#profile(hook, identity.surface);
    if (auto && !this.#options.auto.allows(profile.project)) return 'skipped';
    for (const record of this.#records.values()) {
      if (record.sessionId !== sessionId && processKey(record.identity) === processKey(identity.snapshot)) this.#retire(record.sessionId);
    }
    this.#attach(sessionId, identity.snapshot, socket, profile);
    return 'registered';
  }

  // Any submitted prompt whose whole trimmed text is the command reaches here, typed or not (same-UID trust);
  // the model itself has no Skill operation or invocable command for this switch.
  async #auto(request: StdioRequest, input: string): Promise<DailyHookResult> {
    const action = parseAutoInput(input);
    if (action === null) {
      return blockOutput(`Switchboard 自动登记失败（INVALID_COMMAND_INPUT）：用法 ${DAILY_COMMANDS.auto[0]} on|off|status；本提示未发送给模型。`);
    }
    try {
      await this.#identify(request.peer);
      if (action !== 'status') await this.#options.auto.set(action === 'on');
      const { enabled, projects } = this.#options.auto;
      return blockOutput(`${autoRegisterText('claude-code', action, enabled(), projects())}本提示未发送给模型。`);
    } catch (error) {
      return blockOutput(`Switchboard 自动登记失败（${failure(error)}；本提示未发送给模型。`);
    }
  }

  // Same typed-or-not caveat as /ms:auto: the switch is the user's command, the model has no Skill operation for it.
  async #reply(request: StdioRequest, input: string): Promise<DailyHookResult> {
    const action = parseReplyInput(input, 'claude-code');
    if (action === null) {
      return blockOutput(`Switchboard 回复档位设置失败（INVALID_COMMAND_INPUT）：用法 ${REPLY_COMMANDS['claude-code']} direct|confirm|act|status；`
        + '本提示未发送给模型。');
    }
    try {
      await this.#identify(request.peer);
      if (action !== 'status') await this.#options.reply.set(action);
      const text = replyModeText('claude-code', action, this.#options.reply.mode(), this.#options.act.preset());
      return blockOutput(`${text}本提示未发送给模型。`);
    } catch (error) {
      return blockOutput(`Switchboard 回复档位设置失败（${failure(error)}；本提示未发送给模型。`);
    }
  }

  // The mode goes beside the letter, never into it. A caller that is not the registered session, or a letter msd did not deliver
  // to it, gets nothing, so the letter reaches the model as is and the rules fall back to confirm. Under act the letter turn is
  // marked first; where it cannot be (no socket, a mode that cannot prompt) the letter is handled as direct.
  async #letter(request: StdioRequest, hook: Hook, socketPath: string | null, prompt: string): Promise<DailyHookResult> {
    try {
      const sessionId = hook.session_id as string;
      const identity = await this.#identify(request.peer);
      const record = this.#current(sessionId);
      if (!record || !same(record.identity, identity.snapshot)) return PASS;
      const messageId = this.#options.board.verifyLetter(ref(sessionId), prompt);
      const mode = this.#options.reply.mode();
      return letterOutput(replyModeLine(mode === 'act' ? await this.#act.letterMode(hook, socketPath, prompt, messageId) : mode));
    } catch { return PASS; }
  }

  async #prompt(request: StdioRequest, hook: Hook, socketPath: string | null): Promise<DailyHookResult> {
    const raw = typeof hook.prompt === 'string' ? hook.prompt : '';
    if (isLetterPrompt(raw)) return this.#letter(request, hook, socketPath, raw);
    const prompt = raw.trim();
    const auto = dailyAutoInput(prompt);
    if (auto !== null) return this.#auto(request, auto);
    const reply = dailyReplyInput(prompt);
    if (reply !== null) return this.#reply(request, reply);
    const register = DAILY_COMMANDS.register.includes(prompt);
    if (!register && !DAILY_COMMANDS.unregister.includes(prompt)) return PASS;
    const sessionId = hook.session_id as string;
    try {
      const identity = await this.#identify(request.peer);
      if (register) {
        const state = await this.#register(identity, hook, socketPath, false);
        const project = this.#options.board.contact(ref(sessionId))?.project;
        return blockOutput(`${registeredLine(state === 'skipped' ? 'registered' : state, sessionId, identity.surface, project)}；本提示未发送给模型。`);
      }
      const record = this.#current(sessionId);
      if (!record || !same(record.identity, identity.snapshot)) {
        return blockOutput(`当前会话 ${sessionId} 未登记 Switchboard，无需撤销；本提示未发送给模型。`);
      }
      this.#retire(sessionId);
      return blockOutput(`已撤销 Switchboard 登记：claude-code 会话 ${sessionId} 现为离线，线路保留，重新 /ms:register 后续上。本提示未发送给模型。`);
    } catch (error) {
      return blockOutput(`Switchboard ${register ? '登记' : '撤销'}失败（${failure(error)}；本提示未发送给模型。`);
    }
  }

  async #lifecycle(request: StdioRequest, hook: Hook, socketPath: string | null): Promise<DailyHookResult> {
    const sessionId = hook.session_id as string;
    if (hook.hook_event_name === 'SessionStart') await this.#act.sessionStart(hook, socketPath);
    else await this.#act.sessionEnd(hook);
    if (hook.hook_event_name === 'SessionStart') {
      if (this.#options.auto.enabled()) {
        try { await this.#register(await this.#identify(request.peer), hook, socketPath, true); }
        catch { /* Silent: the user can run /ms:register to see the fixed code. */ }
      }
      return PASS;
    }
    const record = this.#current(sessionId);
    if (!record) return PASS;
    const caller = request.snapshots[0]?.[0];
    if (caller && caller.pid === request.peer.pid && caller.pidVersion === request.peer.pidVersion
        && caller.parentPid === record.identity.pid && caller.parentUniqueId === record.identity.uniqueId) {
      this.#retire(sessionId);
      return PASS;
    }
    try {
      const { snapshot } = await this.#identify(request.peer);
      if (same(record.identity, snapshot)) this.#retire(sessionId);
    } catch { /* An unverifiable End cannot take another generation offline; the next send's live check will. */ }
    return PASS;
  }

  async #dispatch(record: ClaudeRecord, request: Exclude<DailyRequest, Readonly<{ operation: 'register' }> | Readonly<{ operation: 'unregister' }>>): Promise<unknown> {
    const { board } = this.#options;
    const sender = Object.freeze({ ...ref(record.sessionId), generation: record.generation });
    if (request.operation === 'list') {
      const rows = board.list({ harness: request.harness, project: request.project });
      return directoryContext(rows.filter(row => row.harness !== 'claude-code'));
    }
    if (request.operation === 'send') {
      return sendContext(await board.send(sender, { harness: request.harness, target: request.target, project: request.project,
        messageId: request.messageId, body: request.body }));
    }
    return sendContext(await board.reply(sender, { inReplyTo: request.inReplyTo, messageId: request.messageId, body: request.body }));
  }

  async #skill(request: StdioRequest, hook: Hook, socketPath: string | null): Promise<DailyHookResult> {
    const call = parseSkillCall(hook);
    const key = JSON.stringify([call.sessionId, call.toolUseId]);
    if (call.event === 'PreToolUse') {
      if (!this.#expectations.has(key)) {
        this.#expectations = new Map([...this.#expectations, [key, Object.freeze({ originalArgs: call.originalArgs,
          generation: this.#current(call.sessionId)?.generation ?? null })]]);
      }
      return PASS;
    }
    try {
      const identity = await this.#identify(request.peer);
      const expected = this.#expectations.get(key);
      if (!expected) throw new Error('SKILL_PRE_MISSING');
      if (expected.originalArgs !== call.originalArgs) throw new Error('SKILL_INVOCATION_CONFLICT');
      if (!call.succeeded) throw new Error('SKILL_NOT_RUN');
      const parsed = parseDailyRequest(call.originalArgs);
      if (parsed.operation === 'register' || parsed.operation === 'unregister') {
        // Membership changes the generation itself, so its replay returns the first result instead of re-checking it.
        const operation = parsed.operation;
        return postOutput(await this.#once(key, expected, () => this.#membership(operation, identity, hook, socketPath)));
      }
      let record = this.#current(call.sessionId);
      if (expected.generation !== null && record?.generation !== expected.generation) throw new Error('SKILL_PRE_MISSING');
      if (!record || !same(record.identity, identity.snapshot)) {
        await this.#register(identity, hook, socketPath, false);
        record = this.#current(call.sessionId) ?? (() => { throw new Error('NOT_REGISTERED'); })();
      }
      const current = record;
      return postOutput(await this.#once(key, expected, () => this.#dispatch(current, parsed)));
    } catch (error) { return postOutput(errorContext(code(error))); }
  }

  #once(key: string, expected: Expectation, run: () => Promise<unknown>): Promise<unknown> {
    if (expected.result) return expected.result;
    const result = run();
    this.#expectations = new Map([...this.#expectations, [key, Object.freeze({ ...expected, result })]]);
    return result;
  }

  async #membership(operation: 'register' | 'unregister', identity: Identity, hook: Hook, socketPath: string | null) {
    const sessionId = hook.session_id as string;
    if (operation === 'register') {
      const state = await this.#register(identity, hook, socketPath, false);
      const project = this.#options.board.contact(ref(sessionId))?.project ?? null;
      return Object.freeze({ ok: true, registered: true, sessionId, surface: identity.surface, project,
        note: `${registeredLine(state === 'skipped' ? 'registered' : state, sessionId, identity.surface, project)}。请如实告诉用户已登记。` });
    }
    const record = this.#current(sessionId);
    if (!record || !same(record.identity, identity.snapshot)) {
      return Object.freeze({ ok: true, unregistered: false, sessionId, note: '当前会话未登记 Switchboard，无需撤销。请如实告诉用户。' });
    }
    this.#retire(sessionId);
    return Object.freeze({ ok: true, unregistered: true, sessionId,
      note: `已撤销 Switchboard 登记：claude-code 会话 ${sessionId} 现为离线，线路保留；重新登记后续上。请如实告诉用户已撤销。` });
  }

  async handle(request: StdioRequest): Promise<DailyHookResult> {
    const { hook, messagingSocket, act, turn } = parseDailyHook(request.payload);
    const event = hook.hook_event_name;
    if (act) return event === 'PreToolUse' ? this.#act.gate(hook) : PASS;
    if (turn) {
      if (event === 'Stop' || event === 'StopFailure') this.#act.turnEnded(hook);
      return PASS;
    }
    if (event === 'UserPromptSubmit') return this.#prompt(request, hook, messagingSocket);
    if (event === 'SessionStart' || event === 'SessionEnd') return this.#lifecycle(request, hook, messagingSocket);
    if ((event === 'PreToolUse' || event === 'PostToolUse') && isDailySkill(hook)) return this.#skill(request, hook, messagingSocket);
    return PASS;
  }

  async restore(): Promise<number> {
    let restored = 0;
    for (const contact of this.#options.board.contacts()) {
      const binding = contact.binding as { identity?: SignedSnapshot; socket?: AppSocketPin } | null;
      if (contact.harness !== 'claude-code' || !binding?.identity || !binding.socket) continue;
      try {
        await this.#live(binding.identity, binding.socket);
        this.#attach(contact.sessionId, binding.identity, binding.socket, { surface: contact.clientSurface,
          title: contact.title, cwd: contact.cwd, project: contact.project });
        restored++;
      } catch { /* The recorded process or socket is gone; the contact stays offline. */ }
    }
    return restored;
  }

  unregister(sessionId: string): boolean { return this.#retire(sessionId); }
}

export function createClaudeHooks(options: Options) {
  const hooks = new ClaudeHooks(options);
  return Object.freeze({ handle: (request: StdioRequest) => hooks.handle(request), restore: () => hooks.restore(),
    unregister: (sessionId: string) => hooks.unregister(sessionId) });
}
