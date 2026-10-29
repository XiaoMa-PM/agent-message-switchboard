// INPUT: Daily hook calls of a registered Claude session under act (prompt, session, PreToolUse, Stop hooks), act preset.
// OUTPUT: createClaudeAct (letterMode, sessionStart, turnEnded, sessionEnd, gate), SESSION_ID, MAINTENANCE_TASKS.
// POS: msd side of the Claude act letter turn and its settlement; ms only tightens, it never answers allow.
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { type DailyHookResult } from '../bridge/hook-output.ts';
import { actAskReason, actDenyReason, actSenderOf, type ActSender } from '../protocol/act-text.ts';
import { actDecision, classifyPeerCall, type ActPreset, type PeerVerdict } from '../protocol/peer-tiers.ts';
import { type ReceiptReason } from '../protocol/receipt-text.ts';
import { type ReplyMode } from '../protocol/reply-mode-text.ts';
import { PASS } from './claude-skill.ts';

export type ActOptions = Readonly<{ preset: () => ActPreset; markers: string; home: string }>;
type Settle = (sessionId: string, letters: readonly string[], reason: ReceiptReason) => void;
type Options = ActOptions & Readonly<{ projectOf: (cwd: string | null) => Promise<string | null>; settle: Settle }>;
type Hook = Readonly<Record<string, unknown>>;
// A letter of an act letter turn under the prompt_id of the UserPromptSubmit it came in; stopped once its own Stop came while
// background work was left.
type Letter = Readonly<{ messageId: string; promptId: string; stopped: boolean }>;

// Modes in which the host cannot put an approval prompt to the user.
const NO_PROMPT: ReadonlySet<unknown> = new Set(['dontAsk', 'bypassPermissions']);
const INVALID: PeerVerdict = Object.freeze({ tier: 'L3', reason: 'invalid-input' });
// Claude makes session ids with randomUUID and keeps a --session-id as given (any case); anything else, such as a hook relayed for
// another host ("served:<id>"), is never a marker name, so it cannot point outside the marker directory.
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Claude's own housekeeping tasks, which never continue a letter; the plugin's Stop check is built from the same list.
export const MAINTENANCE_TASKS = Object.freeze(['dream', 'auto-mode scan', 'memory import'] as const);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const promptOf = (hook: Hook): string | null => typeof hook.prompt_id === 'string' && hook.prompt_id !== '' ? hook.prompt_id : null;
// Anything but a list of housekeeping tasks is work that may wake the session in a turn that continues the letter (as STOP_CHECK).
const idle = (tasks: unknown) => Array.isArray(tasks)
  && tasks.every(task => isRecord(task) && (MAINTENANCE_TASKS as readonly unknown[]).includes(task.type));

// A letter is judged by its own turn. Its own Stop ends it, or leaves it waiting while background
// work is listed; its own StopFailure fails it. The Stop or StopFailure of another turn while it never had its own means its turn
// ended without any hook (No without a note, or Esc), so it was interrupted. A waiting letter only a clean Stop ends.
function outcome(letter: Letter, hook: Hook, promptId: string): ReceiptReason | 'wait' {
  const own = letter.promptId === promptId;
  if (hook.hook_event_name === 'StopFailure') return own ? 'failed' : letter.stopped ? 'wait' : 'interrupted';
  if (!own && !letter.stopped) return 'interrupted';
  return idle(hook.background_tasks) ? 'ended' : 'wait';
}

function permission(decision: 'ask' | 'deny', reason: string): DailyHookResult {
  return Object.freeze({ hookOutput: Object.freeze({ hookSpecificOutput: Object.freeze({ hookEventName: 'PreToolUse' as const,
    permissionDecision: decision, permissionDecisionReason: reason }) }) });
}

class ClaudeAct {
  #options: Options;
  #senders = new Map<string, ActSender>();
  #letters = new Map<string, readonly Letter[]>();

  constructor(options: Options) { this.#options = options; }

  #marker(socketPath: string | null): string | null {
    const name = socketPath === null ? '' : basename(socketPath);
    return name === '' || name === '.' || name === '..' ? null : join(this.#options.markers, name);
  }

  // One settle call per reason, in the order the letters came; the waiting ones stay open.
  #settle(sessionId: string, decided: readonly (readonly [Letter, ReceiptReason | 'wait'])[]): void {
    const left = decided.filter(([, reason]) => reason === 'wait').map(([letter]) => Object.freeze({ ...letter, stopped: true }));
    const others = [...this.#letters].filter(([id]) => id !== sessionId);
    this.#letters = new Map(left.length ? [...others, [sessionId, Object.freeze(left)]] : others);
    for (const reason of new Set(decided.map(([, item]) => item))) {
      if (reason === 'wait') continue;
      this.#options.settle(sessionId, decided.filter(([, item]) => item === reason).map(([letter]) => letter.messageId), reason);
    }
  }

  // Two markers per letter turn: by session id (CLAUDE_CODE_SESSION_ID, which survives a resumed process; a forked id is a known
  // limit) and by socket, the hooks' fallback without that variable. A letter without a prompt_id is gated but never settled.
  async letterMode(hook: Hook, socketPath: string | null, prompt: string, messageId: string): Promise<ReplyMode> {
    const marker = this.#marker(socketPath); const sessionId = hook.session_id;
    if (marker === null || typeof sessionId !== 'string' || !SESSION_ID.test(sessionId) || NO_PROMPT.has(hook.permission_mode)) return 'direct';
    try {
      await mkdir(this.#options.markers, { recursive: true, mode: 0o700 });
      for (const path of [join(this.#options.markers, sessionId), marker]) await writeFile(path, sessionId, { mode: 0o600 });
    } catch { return 'direct'; }
    this.#senders = new Map([...this.#senders, [sessionId, actSenderOf(prompt)]]);
    const promptId = promptOf(hook);
    if (promptId !== null) {
      const letter = Object.freeze({ messageId, promptId, stopped: false });
      this.#letters = new Map([...this.#letters, [sessionId, Object.freeze([...this.#letters.get(sessionId) ?? [], letter])]]);
    }
    return 'act';
  }

  // A socket marker left by another session (a reused process id) is stale; this session's own stays until Stop, as does any
  // session id marker, which is never another session's (strict until the next Stop).
  async sessionStart(hook: Hook, socketPath: string | null): Promise<void> {
    const marker = this.#marker(socketPath);
    if (marker === null) return;
    try { if (await readFile(marker, 'utf8') !== hook.session_id) await rm(marker, { force: true }); } catch { /* No marker. */ }
  }

  // Stop or StopFailure of a marked session, any turn; a signal without a prompt_id settles nothing.
  turnEnded(hook: Hook): void {
    const sessionId = hook.session_id as string; const promptId = promptOf(hook);
    const letters = this.#letters.get(sessionId) ?? [];
    if (promptId === null || letters.length === 0 || (hook.hook_event_name !== 'Stop' && hook.hook_event_name !== 'StopFailure')) return;
    this.#settle(sessionId, letters.map(letter => [letter, outcome(letter, hook, promptId)] as const));
  }

  // SessionEnd carries no messaging socket, so this session's socket markers are found by the session id they hold. The id marker
  // stays because a resumed turn keeps the same id: only Stop ends it (strict). Open letters close first.
  async sessionEnd(hook: Hook): Promise<void> {
    const sessionId = hook.session_id as string;
    this.#settle(sessionId, (this.#letters.get(sessionId) ?? []).map(letter => [letter, 'closed'] as const));
    this.#senders = new Map([...this.#senders].filter(([id]) => id !== sessionId));
    let names: string[] = [];
    try { names = await readdir(this.#options.markers); } catch { return; }
    for (const name of names.filter(item => item !== sessionId)) {
      const path = join(this.#options.markers, name);
      try { if (await readFile(path, 'utf8') === sessionId) await rm(path, { force: true }); } catch { /* Gone meanwhile. */ }
    }
  }

  async gate(hook: Hook): Promise<DailyHookResult> {
    const sender = this.#senders.get(hook.session_id as string) ?? null;
    const preset = this.#options.preset();
    const { cwd, tool_name: tool, tool_input: input } = hook;
    if (typeof cwd !== 'string' || !isAbsolute(cwd) || typeof tool !== 'string' || !isRecord(input)) {
      return permission('deny', actDenyReason(sender, INVALID, preset, false));
    }
    let workspace = cwd;
    try { workspace = await this.#options.projectOf(cwd) ?? cwd; } catch { /* The cwd stands in for the project. */ }
    const verdict = classifyPeerCall({ harness: 'claude-code', tool, input }, { workspace, cwd, home: this.#options.home });
    const decision = actDecision(preset, verdict);
    if (decision === 'pass') return PASS;
    const noPrompt = NO_PROMPT.has(hook.permission_mode);
    if (decision === 'approve' && !noPrompt) return permission('ask', actAskReason(sender, verdict, preset));
    return permission('deny', actDenyReason(sender, verdict, preset, decision === 'approve'));
  }
}

export function createClaudeAct(options: Options) {
  const act = new ClaudeAct(options);
  return Object.freeze({
    letterMode: (hook: Hook, socketPath: string | null, prompt: string, messageId: string) => act.letterMode(hook, socketPath, prompt, messageId),
    sessionStart: (hook: Hook, socketPath: string | null) => act.sessionStart(hook, socketPath),
    turnEnded: (hook: Hook) => act.turnEnded(hook), sessionEnd: (hook: Hook) => act.sessionEnd(hook), gate: (hook: Hook) => act.gate(hook) });
}
