// INPUT: Codex hook arguments from the ms plugin's mcp_tool templates, a verified act letter's thread, turn_id and text, the act preset.
// OUTPUT: createCodexAct → open, preToolUse and permissionRequest (in a letter turn: a deny or nothing / always a deny), turnEnded.
// POS: Codex side of the act letter turn, in the ms MCP process, never through msd; code-mode cells outlive the turn; ms only tightens.
import { isAbsolute } from 'node:path';
import { actDenyReason, actEscalationReason, actHandOffReason, actSenderOf, actUnavailableReason, type ActSender }
  from '../../protocol/act-text.ts';
import { actDecision, classifyPeerCall, type ActPreset, type PeerVerdict } from '../../protocol/peer-tiers.ts';
import { type ReceiptReason } from '../../protocol/receipt-text.ts';

export type CodexActOptions = Readonly<{ preset: () => ActPreset | null; projectOf: (cwd: string) => Promise<string | null>;
  home: string }>;
export type HookOutput = Readonly<{ hookSpecificOutput: Readonly<Record<string, unknown>> }>;
export type TurnLetters = Readonly<{ reason: ReceiptReason; messageIds: readonly string[] }>;
type LetterTurn = Readonly<{ sender: ActSender; threadId: string; letters: readonly string[]; reported: boolean }>;

// One table per MCP process, bounded: past it the oldest letter turn stops being gated (known limitation). A cell yielded
// that many letters ago is not expected to be still calling tools.
export const LETTER_TURNS = 1024;
const INVALID: PeerVerdict = Object.freeze({ tier: 'L3', reason: 'invalid-input' });
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const turnOf = (hook: unknown) => (isRecord(hook) && typeof hook.turn_id === 'string' ? hook.turn_id : undefined);
// The two hooks say only how this turn ended; a turn that ended in an error fires neither.
const REASONS: Readonly<Record<string, ReceiptReason>> = Object.freeze({ Stop: 'ended', Interrupt: 'interrupted' });

const preToolUseDeny = (reason: string): HookOutput => Object.freeze({ hookSpecificOutput: Object.freeze({
  hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason }) });

class LetterTurns {
  #options: CodexActOptions;
  // turn_id → letter turn, oldest first. UserPromptSubmit and PreToolUse share the turn_id, and a code-mode cell's nested
  // calls keep the turn_id of the exec that started it, even after that turn is over, so an entry is never removed when its turn
  // ends, only marked reported. Turn ids are unique, so a kept entry only ever matches its own turn.
  #turns: ReadonlyMap<string, LetterTurn> = new Map();

  constructor(options: CodexActOptions) { this.#options = options; }

  // A letter steered into the turn joins its unreported letters; one steered in after Stop already reported them starts anew.
  open(threadId: string, turnId: string, messageId: string, letter: string): void {
    const before = this.#turns.get(turnId);
    const letters = before === undefined || before.reported ? [] : before.letters;
    const kept = [...this.#turns].filter(([key]) => key !== turnId).slice(-(LETTER_TURNS - 1));
    this.#turns = new Map([...kept, [turnId, Object.freeze({ sender: actSenderOf(letter), threadId,
      letters: Object.freeze([...letters, messageId]), reported: false })]]);
  }

  // This turn's letters go by how it ended; the thread's other unreported letter turns ended earlier without either hook (an error),
  // so they go as unknown. Every one is reported once; an evicted turn is gone and never reported.
  turnEnded(threadId: string, turnId: string, event: string): readonly TurnLetters[] {
    const reason = Object.hasOwn(REASONS, event) ? REASONS[event] : undefined;
    if (reason === undefined) return Object.freeze([]);
    const pending = [...this.#turns].filter(([, turn]) => turn.threadId === threadId && !turn.reported);
    if (pending.length === 0) return Object.freeze([]);
    const lettersOf = (own: boolean) => pending.filter(([key]) => (key === turnId) === own).flatMap(([, turn]) => turn.letters);
    this.#turns = new Map([...this.#turns].map(([key, turn]) => [key,
      turn.threadId === threadId && !turn.reported ? Object.freeze({ ...turn, reported: true }) : turn]));
    return Object.freeze([{ reason, messageIds: lettersOf(true) }, { reason: 'unknown' as const, messageIds: lettersOf(false) }]
      .filter(group => group.messageIds.length > 0).map(group => Object.freeze({ ...group, messageIds: Object.freeze(group.messageIds) })));
  }

  #sender(turnId: string | undefined): ActSender | undefined {
    return turnId === undefined || !this.#turns.has(turnId) ? undefined : this.#turns.get(turnId)?.sender ?? null;
  }

  async preToolUse(hook: unknown): Promise<HookOutput | undefined> {
    const sender = this.#sender(turnOf(hook));
    if (sender === undefined) return undefined;
    let reason: string | null;
    try { reason = await this.#decide(hook as Record<string, unknown>, sender); }
    catch { reason = actUnavailableReason('ACT_GATE_FAILED'); }
    return reason === null ? undefined : preToolUseDeny(reason);
  }

  // A letter turn never asks: Guardian (auto_review) and the user would both see the peer's request as this session's own.
  permissionRequest(hook: unknown): HookOutput | undefined {
    const sender = this.#sender(turnOf(hook));
    if (sender === undefined) return undefined;
    return Object.freeze({ hookSpecificOutput: Object.freeze({ hookEventName: 'PermissionRequest',
      decision: Object.freeze({ behavior: 'deny', message: actEscalationReason(sender) }) }) });
  }

  async #decide(hook: Record<string, unknown>, sender: ActSender): Promise<string | null> {
    const preset = this.#options.preset() ?? 'read-only';
    const { tool_name: tool, tool_input: input, cwd } = hook;
    if (typeof tool !== 'string' || !isRecord(input) || typeof cwd !== 'string' || !isAbsolute(cwd)) {
      return actDenyReason(sender, INVALID, preset, false);
    }
    let workspace = cwd;
    try { workspace = await this.#options.projectOf(cwd) ?? cwd; } catch { /* The cwd stands in for the project. */ }
    const verdict = classifyPeerCall({ harness: 'codex', tool, input }, { workspace, cwd, home: this.#options.home });
    const decision = actDecision(preset, verdict);
    if (decision === 'pass') return null;
    return decision === 'approve' ? actHandOffReason(sender, verdict, preset) : actDenyReason(sender, verdict, preset, false);
  }
}

export function createCodexAct(options: CodexActOptions) {
  const turns = new LetterTurns(options);
  return Object.freeze({
    open: (threadId: string, turnId: string, messageId: string, letter: string) => turns.open(threadId, turnId, messageId, letter),
    preToolUse: (hook: unknown) => turns.preToolUse(hook), permissionRequest: (hook: unknown) => turns.permissionRequest(hook),
    turnEnded: (threadId: string, turnId: string, event: string) => turns.turnEnded(threadId, turnId, event) });
}
export type CodexAct = ReturnType<typeof createCodexAct>;
