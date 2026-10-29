// INPUT: Top-level DSH agents, agent/inbox/claimed/turn/job events, the client's reply mode and act preset, approval policy, cwd, resolver.
// OUTPUT: createDshAct → watch, claimed, sessionEvent, jobEvent, disposed, canAct, dispose: opens letter turns and reports their letters.
// POS: DSH side of the act letter turn, in the host process, never through msd; outside a letter turn a gate is one Map lookup.
import { isAbsolute } from 'node:path';
import { actAskReason, actDenyReason, actSenderOf, actUnavailableReason, type ActSender } from '../../protocol/act-text.ts';
import { isMessageId } from '../../protocol/message.ts';
import { actDecision, classifyPeerCall, type ActPreset, type PeerVerdict } from '../../protocol/peer-tiers.ts';
import { type ReceiptReason } from '../../protocol/receipt-text.ts';
import { type ReplyMode } from '../../protocol/reply-mode-text.ts';

type Next = () => Promise<unknown>;
type Gate = (exec: unknown, next: Next) => Promise<unknown>;
export type ActAgent = Readonly<{ id: string; session: unknown;
  ctx: Readonly<{ on: (name: 'tools/pre-execute', listener: Gate) => () => void }> }>;
export type LetterTurnEnd = Readonly<{ sessionId: string; letters: readonly string[]; reason: ReceiptReason }>;
type Options = Readonly<{ mode: () => ReplyMode | null; preset: () => ActPreset | null; policy: (agent: ActAgent) => unknown;
  nativeTools: (agent: ActAgent) => unknown; cwd: (agent: ActAgent) => unknown; projectOf: (cwd: string) => Promise<string | null>;
  home: string; onLetterTurnEnd: (end: LetterTurnEnd) => void }>;
type LetterTurn = Readonly<{ turn: unknown; sender: ActSender; letters: readonly string[] }>;
// A job registered in a letter turn; once that turn ended with the job outstanding, it carries the turn's letters and end reason.
type LetterJob = Readonly<{ session: string; sender: ActSender; turn: unknown; letters: readonly string[]; reason: ReceiptReason | null }>;
type Decision = Readonly<{ kind: 'deny'; reason: string }
  | { kind: 'ask'; reason: string; displayReason: Readonly<{ zh: string; en: string }> }>;

const PEER = 'agent-message-switchboard-peer';
// dsh-tool-jobs: a settled background job's notice is a tool-jobs message whose text starts "background job <id> (<kind>: …".
const JOBS = 'tool-jobs';
const NOTICE = /^background job (\S+) \(/;
const INVALID: PeerVerdict = Object.freeze({ tier: 'L3', reason: 'invalid-input' });
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const sessionId = (session: unknown) => {
  const header = isRecord(session) ? session.header : undefined;
  return isRecord(header) && typeof header.id === 'string' ? header.id : undefined;
};
const deny = (reason: string): Decision => Object.freeze({ kind: 'deny', reason });
// The approval card shows displayReason (the zh key under a Chinese UI) and has no source label of its own, so the
// reason names the sender; en is the fallback for other locales.
const ask = (reason: string): Decision => Object.freeze({ kind: 'ask', reason, displayReason: Object.freeze({ zh: reason, en: reason }) });

function textOf(message: Record<string, unknown>): string | undefined {
  const block = Array.isArray(message.content) ? message.content.find(item => isRecord(item) && item.type === 'text') : undefined;
  return isRecord(block) && typeof block.text === 'string' ? block.text : undefined;
}
const senderOf = (message: Record<string, unknown>): ActSender => {
  const text = textOf(message);
  return text === undefined ? null : actSenderOf(text);
};
// msd refuses a whole report holding an id it cannot take, so such a letter is gated but never reported.
const letterOf = (source: Record<string, unknown>): readonly string[] => (isMessageId(source.messageId) ? [source.messageId] : []);
const union = (left: readonly string[], right: readonly string[]) => Object.freeze([...new Set([...left, ...right])]);

// Completed is ended; error and max-tokens failed; aborted by the user, a hook or the parent interrupted; aborted by
// disposal closed; blocked and anything unreadable unknown.
function reasonOf(value: unknown): ReceiptReason {
  const kind = isRecord(value) ? value.kind : undefined;
  if (kind === 'completed') return 'ended';
  if (kind === 'error' || kind === 'max-tokens') return 'failed';
  if (kind !== 'aborted') return 'unknown';
  const cause = isRecord(value) && isRecord(value.reason) ? value.reason.kind : undefined;
  if (cause === 'disposed') return 'closed';
  return cause === 'user' || cause === 'hook' || cause === 'parent' ? 'interrupted' : 'unknown';
}

class LetterTurnGate {
  #options: Options;
  #gates: ReadonlyMap<ActAgent, () => void> = new Map();
  #turns: ReadonlyMap<string, LetterTurn> = new Map();
  #jobs: ReadonlyMap<string, LetterJob> = new Map();

  constructor(options: Options) { this.#options = options; }

  watch(agent: ActAgent): void {
    if (this.#gates.has(agent)) return;
    const release = agent.ctx.on('tools/pre-execute', (exec, next) => this.#gate(agent, exec, next));
    this.#gates = new Map([...this.#gates, [agent, release]]);
  }

  // A session whose policy is never cannot show an approval, and one presenting its tools as PTC runs run_code programs whose
  // Node APIs no tool call sees (DSH's sandbox only limits writes), so their letters stay direct; a subagent is never
  // watched. This runs in every prompt assembly, so anything that cannot be read counts as unable instead of failing the assembly.
  canAct(agent: unknown): boolean {
    if (!this.#gates.has(agent as ActAgent)) return false;
    try {
      return this.#options.policy(agent as ActAgent) === 'ask' && this.#options.nativeTools(agent as ActAgent) === true;
    } catch { return false; }
  }

  // A queued message opens its own later turn, so only the claiming turn is a letter turn; a steer or interjection
  // claimed inside it never ends it. A job the letter turn registered wakes the session in a later turn when the
  // host moved it to the background: the turn that claims its notice is gated for the same sender.
  claimed(event: unknown): void {
    if (!isRecord(event) || !isRecord(event.message) || !isRecord(event.message.source)) return;
    const id = sessionId((event.agent as ActAgent | undefined)?.session);
    if (id === undefined) return;
    const kind = event.message.source.kind;
    if (kind === PEER && this.#options.mode() === 'act' && this.canAct(event.agent)) {
      this.#open(id, event.turn, senderOf(event.message), letterOf(event.message.source));
    }
    if (kind !== JOBS || !this.#gates.has(event.agent as ActAgent)) return;
    const job = this.#letterJob(id, event.message);
    if (job !== undefined) this.#open(id, event.turn, job.sender, job.letters);
  }

  // A registered job belongs to the letter turn its owner is in; a foreground call's own job is awaited and never notifies.
  jobEvent(event: unknown): void {
    if (!isRecord(event) || !isRecord(event.job) || typeof event.job.id !== 'string') return;
    const jobId = event.job.id;
    if (event.type === 'registered') {
      const owner = [...this.#gates.keys()].find(agent => agent.id === (event.job as Record<string, unknown>).owner);
      const session = sessionId(owner?.session);
      const turn = session === undefined ? undefined : this.#turns.get(session);
      if (session === undefined || turn === undefined) return;
      this.#jobs = new Map([...this.#jobs, [jobId, Object.freeze({ session, sender: turn.sender, turn: turn.turn, letters: Object.freeze([]),
        reason: null })]]);
    } else if (event.type === 'removed' || (event.type === 'settled' && event.awaited === true)) {
      const job = this.#jobs.get(jobId);
      this.#jobs = new Map([...this.#jobs].filter(([key]) => key !== jobId));
      // No notice will come for it: what it carried and nothing else holds settles now, for the turn that handed it over.
      const open = job === undefined ? [] : this.#turns.get(job.session)?.letters ?? [];
      if (job?.reason) this.#report(job.session, job.letters.filter(letter => !open.includes(letter)), job.reason);
    }
  }

  // turn/end fires on a normal end and on the stop button (aborted, cause user).
  sessionEvent(session: unknown, event: unknown): void {
    if (!isRecord(event) || event.type !== 'turn/end' || !isRecord(event.data)) return;
    const id = sessionId(session);
    const open = id === undefined ? undefined : this.#turns.get(id);
    if (id === undefined || open === undefined || open.turn !== event.data.turn) return;
    this.#turns = new Map([...this.#turns].filter(([key]) => key !== id));
    const reason = reasonOf(event.data.reason);
    // Jobs this turn registered and left running carry its letters to the turn that claims their notice.
    this.#jobs = new Map([...this.#jobs].map(([key, job]) => [key, job.session === id && job.turn === open.turn
      ? Object.freeze({ ...job, letters: union(job.letters, open.letters), reason }) : job]));
    this.#report(id, open.letters, reason);
  }

  disposed(agent: unknown): void {
    const release = this.#gates.get(agent as ActAgent);
    const id = sessionId((agent as ActAgent | undefined)?.session);
    if (id !== undefined) {
      const carried = [...this.#jobs.values()].filter(job => job.session === id).flatMap(job => job.letters);
      this.#report(id, union(this.#turns.get(id)?.letters ?? [], carried), 'closed', true);
    }
    this.#gates = new Map([...this.#gates].filter(([key]) => key !== agent));
    this.#turns = new Map([...this.#turns].filter(([key]) => key !== id));
    this.#jobs = new Map([...this.#jobs].filter(([, job]) => job.session !== id));
    release?.();
  }

  dispose(): void {
    const releases = [...this.#gates.values()];
    this.#gates = new Map(); this.#turns = new Map(); this.#jobs = new Map();
    for (const release of releases) release();
  }

  // A letter claimed while another is still open joins it, so they settle together at the next turn end.
  #open(session: string, turn: unknown, sender: ActSender, letters: readonly string[]): void {
    const previous = this.#turns.get(session)?.letters ?? [];
    this.#turns = new Map([...this.#turns, [session, Object.freeze({ turn, sender, letters: union(previous, letters) })]]);
  }

  // A letter an outstanding job of the session still carries waits for that job; the rest go to msd, which decides on a receipt.
  // The callback's failure never touches the gate. On disposal the jobs go too, so nothing is held back.
  #report(session: string, letters: readonly string[], reason: ReceiptReason, final = false): void {
    const held = final ? [] : [...this.#jobs.values()].filter(job => job.session === session).flatMap(job => job.letters);
    const due = Object.freeze(letters.filter(letter => !held.includes(letter)));
    if (due.length === 0) return;
    try { this.#options.onLetterTurnEnd(Object.freeze({ sessionId: session, letters: due, reason })); } catch { /* Receipts are best effort. */ }
  }

  // The notice names its job; one this session's letter turn registered is consumed. A notice that cannot be read is gated while
  // any such job is still outstanding (strict).
  #letterJob(session: string, message: Record<string, unknown>): LetterJob | undefined {
    const found = NOTICE.exec(textOf(message) ?? '');
    if (found === null) return [...this.#jobs.values()].find(job => job.session === session);
    const job = this.#jobs.get(found[1]);
    if (job?.session !== session) return undefined;
    this.#jobs = new Map([...this.#jobs].filter(([key]) => key !== found[1]));
    return job;
  }

  async #gate(agent: ActAgent, exec: unknown, next: Next): Promise<unknown> {
    const id = sessionId(agent.session);
    const turn = id === undefined ? undefined : this.#turns.get(id);
    if (turn === undefined) return next();
    let decision: Decision | null;
    // A gate that throws already stops the call, but the model would read the raw error; this deny says what happened.
    try { decision = await this.#decide(agent, exec, turn.sender); } catch { decision = deny(actUnavailableReason('ACT_GATE_FAILED')); }
    return decision ?? next();
  }

  async #decide(agent: ActAgent, exec: unknown, sender: ActSender): Promise<Decision | null> {
    const preset = this.#options.preset() ?? 'read-only';
    const cwd = this.#options.cwd(agent);
    const input = isRecord(exec) ? exec.arguments : undefined;
    if (!isRecord(exec) || typeof exec.name !== 'string' || !isRecord(input) || typeof cwd !== 'string' || !isAbsolute(cwd)) {
      return deny(actDenyReason(sender, INVALID, preset, false));
    }
    let workspace = cwd;
    try { workspace = await this.#options.projectOf(cwd) ?? cwd; } catch { /* The cwd stands in for the project. */ }
    const verdict = classifyPeerCall({ harness: 'dsh', tool: exec.name, input }, { workspace, cwd, home: this.#options.home });
    const decision = actDecision(preset, verdict);
    if (decision === 'pass') return null;
    if (decision === 'approve' && this.#options.policy(agent) === 'ask') return ask(actAskReason(sender, verdict, preset));
    return deny(actDenyReason(sender, verdict, preset, decision === 'approve'));
  }
}

export function createDshAct(options: Options) {
  const act = new LetterTurnGate(options);
  return Object.freeze({ watch: (agent: ActAgent) => act.watch(agent), canAct: (agent: unknown) => act.canAct(agent),
    claimed: (event: unknown) => act.claimed(event), sessionEvent: (session: unknown, event: unknown) => act.sessionEvent(session, event),
    jobEvent: (event: unknown) => act.jobEvent(event),
    disposed: (agent: unknown) => act.disposed(agent), dispose: () => act.dispose() });
}
export type DshAct = ReturnType<typeof createDshAct>;
