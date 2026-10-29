// INPUT: Trusted session registrations, one-step send/reply requests from online senders, link budget, clock and state store.
// OUTPUT: Session-pair links, ordered pushes, reply-hint decisions, persisted metadata, verifyLetter, letterTurnEnded settlement and receipts.
// POS: msd routing core; harness-agnostic, no transport ownership, identity proof or body persistence.
import { createHash, randomUUID } from 'node:crypto';
import { encodeIpcFrame } from '../bridge/ipc-frame.ts';
import { parseInboundText } from '../protocol/inbound-header.ts';
import { receiptText, type ReceiptReason } from '../protocol/receipt-text.ts';
import { BODY_HAS_REPLY_MODE, bodyHasReplyModeLine } from '../protocol/reply-mode-text.ts';
import { isMessageId, parseEnvelope, parsePushOutcome, type Envelope, type Harness, type PushOutcome } from '../protocol/message.ts';
import { Directory, identifier, keyOf, parseHarness, refOf, type ContactRow, type Notice, type Online, type Registration } from './directory.ts';
import { createMemoryStore, type LinkRecord, type MessageRecord, type SessionRef, type StateStore } from './state-store.ts';

export type LinkBudget = Readonly<{ windowSeconds: number; maxPushes: number }>;
export type Sender = Readonly<SessionRef & { generation: string }>;
export type Receipt = Readonly<{ messageId: string; state: PushOutcome['state']; transport: PushOutcome['transport'];
  sequence: number; linkId: string; targetHarness: Harness; targetSessionId: string }>;
export type SendResult = Readonly<{ sent: true; receipt: Receipt }>
  | Readonly<{ sent: false; reason: 'UNKNOWN_TARGET' | 'AMBIGUOUS_TARGET'; candidates: readonly ContactRow[] }>;
export type LinkRow = Readonly<{ linkId: string; a: SessionRef; b: SessionRef; messages: number; paused: boolean; suspended: boolean }>;
export type MessageRow = Readonly<Pick<MessageRecord, 'messageId' | 'linkId' | 'from' | 'to' | 'sentAt' | 'state' | 'bytes'>>;
export type Settlement = Readonly<{ messageId: string; outcome: 'answered' | 'receipted' | 'duplicate' | 'ignored' | 'dropped' }>;
type Options = Readonly<{ store?: StateStore; now?: () => number; budget?: LinkBudget; hostInstanceId?: string }>;
type Prepared = Readonly<{ messageId: string; body: string; inReplyTo: string | null }>;

export const DEFAULT_LINK_BUDGET: LinkBudget = Object.freeze({ windowSeconds: 600, maxPushes: 30 });
const UNKNOWN: PushOutcome = Object.freeze({ state: 'delivery-unknown', transport: null });
const PLACEHOLDER_TIME = '0000-00-00T00:00:00.000Z';

function fail(code: string): never { throw new Error(code); }
const digest = (body: string) => createHash('sha256').update(body, 'utf8').digest('hex');
const same = (left: SessionRef, right: SessionRef) => keyOf(left) === keyOf(right);
const pairKey = (left: SessionRef, right: SessionRef) => JSON.stringify([keyOf(left), keyOf(right)].sort());
// A delivery that most likely put its frame into the recipient session: the reply hint it carried counts as shown.
const reached = (outcome: Readonly<{ state: string; transport: string | null }>) => outcome.state === 'dispatched' || outcome.transport === 'written';
// The letter a record answers: a reply from that letter's own recipient; null for anything else.
function answering(record: MessageRecord, messages: ReadonlyMap<string, MessageRecord>): string | null {
  const letter = record.inReplyTo === null ? undefined : messages.get(record.inReplyTo);
  return letter && same(letter.to, record.from) ? letter.messageId : null;
}

function answeredIndex(messages: ReadonlyMap<string, MessageRecord>): ReadonlyMap<string, readonly string[]> {
  const index = new Map<string, readonly string[]>();
  for (const record of messages.values()) {
    const letterId = answering(record, messages);
    if (letterId !== null && record.state !== 'undelivered') index.set(letterId, Object.freeze([...(index.get(letterId) ?? []), record.messageId]));
  }
  return index;
}

export function parseLinkBudget(value: unknown): LinkBudget {
  const raw = value as Record<string, unknown> | null;
  const positive = (item: unknown) => typeof item === 'number' && Number.isSafeInteger(item) && item > 0;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== 2
      || !positive(raw.windowSeconds) || !positive(raw.maxPushes)) fail('INVALID_CONFIG');
  return Object.freeze({ windowSeconds: raw.windowSeconds as number, maxPushes: raw.maxPushes as number });
}

function messageId(value: unknown): string {
  if (!isMessageId(value)) fail('INVALID_REQUEST');
  return value;
}

function optionalId(value: unknown): string {
  return value === undefined ? randomUUID() : messageId(value);
}

// Every harness's send and reply pass here, so a body that could pass for the host's mode line is refused once for all.
function body(value: unknown): string {
  if (typeof value !== 'string') fail('INVALID_REQUEST');
  if (bodyHasReplyModeLine(value)) fail(BODY_HAS_REPLY_MODE);
  return value;
}

class SwitchboardCore {
  #store: StateStore;
  #now: () => number;
  #budget: LinkBudget;
  #directory: Directory;
  #links = new Map<string, LinkRecord>();
  #pairs = new Map<string, string>();
  #messages = new Map<string, MessageRecord>();
  #inflight = new Map<string, Promise<SendResult>>();
  #pushes = new Map<string, readonly number[]>();
  #tails = new Map<string, Promise<unknown>>();
  #hinted = new Set<string>();
  #hinting = new Set<string>();
  #notified = new Set<string>();
  #answered: ReadonlyMap<string, readonly string[]> = new Map();
  #settled = new Set<string>();

  constructor(options: Options) {
    this.#store = options.store ?? createMemoryStore();
    this.#now = options.now ?? Date.now;
    this.#budget = parseLinkBudget(options.budget ?? DEFAULT_LINK_BUDGET);
    const state = this.#store.load();
    this.#directory = new Directory(state.contacts, { now: this.#now, hostInstanceId: options.hostInstanceId ?? `msd:${process.pid}`,
      persist: () => this.#persist() });
    for (const link of state.links) this.#putLink(link, false);
    this.#messages = new Map(state.messages.map(record => [record.messageId,
      record.state === 'pending' ? Object.freeze({ ...record, state: 'delivery-unknown' as const }) : record]));
    this.#hinted = new Set([...this.#messages.values()].filter(record => reached(record)).map(record => keyOf(record.to)));
    this.#answered = answeredIndex(this.#messages);
  }

  get directory(): Directory { return this.#directory; }
  #time(): string { return new Date(this.#now()).toISOString(); }
  #persist(): void { this.#store.saveDirectory(this.#directory.records(), [...this.#links.values()]); }

  #putLink(link: LinkRecord, persist = true): void {
    this.#links = new Map([...this.#links, [link.linkId, link]]);
    this.#pairs = new Map([...this.#pairs, [pairKey(link.a, link.b), link.linkId]]);
    if (persist) this.#persist();
  }

  #sender(sender: Sender): Online {
    const online = this.#directory.online(sender);
    if (!online || online.generation !== sender.generation) fail('NOT_REGISTERED');
    return online;
  }

  async #reachable(target: SessionRef): Promise<Online> {
    const online = this.#directory.online(target) ?? fail('TARGET_OFFLINE');
    try { await online.verify(); } catch { this.#directory.offline(target, online.generation); fail('TARGET_OFFLINE'); }
    if (this.#directory.online(target) !== online) fail('TARGET_OFFLINE');
    return online;
  }

  #link(from: SessionRef, to: SessionRef): LinkRecord {
    const existing = this.#pairs.get(pairKey(from, to));
    if (existing) return this.#links.get(existing)!;
    const link: LinkRecord = Object.freeze({ linkId: randomUUID(), a: refOf(from), b: refOf(to), createdAt: this.#time(),
      paused: false, sequences: Object.freeze({}) });
    this.#putLink(link);
    return link;
  }

  #charge(link: LinkRecord): void {
    if (link.paused) fail('LINK_PAUSED');
    const now = this.#now();
    const recent = (this.#pushes.get(link.linkId) ?? []).filter(time => time > now - this.#budget.windowSeconds * 1000);
    if (recent.length >= this.#budget.maxPushes) {
      this.#putLink(Object.freeze({ ...link, paused: true }));
      this.#pushes = new Map([...this.#pushes, [link.linkId, Object.freeze(recent)]]);
      fail('LINK_PAUSED');
    }
    this.#pushes = new Map([...this.#pushes, [link.linkId, Object.freeze([...recent, now])]]);
  }

  #replay(sender: Sender, request: Prepared, matches: (record: MessageRecord) => boolean): Promise<SendResult> | null {
    const record = this.#messages.get(request.messageId);
    if (!record || record.state === 'undelivered') return null;
    if (!same(record.from, sender) || record.bodySha256 !== digest(request.body) || !matches(record)) fail('MESSAGE_ID_CONFLICT');
    return this.#inflight.get(request.messageId) ?? Promise.resolve(this.#result(record));
  }

  #result(record: MessageRecord): SendResult {
    return Object.freeze({ sent: true, receipt: Object.freeze({ messageId: record.messageId,
      state: record.state === 'dispatched' ? 'dispatched' : 'delivery-unknown', transport: record.transport, sequence: record.sequence,
      linkId: record.linkId, targetHarness: record.to.harness, targetSessionId: record.to.sessionId }) });
  }

  // A reply is saved pending before its push and again with the result, so the index follows it there and back out on undelivered.
  #save(record: MessageRecord): void {
    this.#messages = new Map([...this.#messages, [record.messageId, record]]);
    const letterId = answering(record, this.#messages);
    if (letterId !== null) {
      const others = (this.#answered.get(letterId) ?? []).filter(id => id !== record.messageId);
      this.#answered = new Map([...this.#answered, [letterId,
        Object.freeze(record.state === 'undelivered' ? others : [...others, record.messageId])]]);
    }
    this.#store.appendMessage(record);
  }

  #envelope(from: Online, to: Online, link: LinkRecord, request: Prepared, sequence: number, sentAt: string): Envelope {
    return parseEnvelope({ schemaVersion: 1, messageId: request.messageId, linkId: link.linkId, sender: from.endpoint,
      recipient: to.endpoint, replyTo: from.endpoint, inReplyTo: request.inReplyTo, body: request.body, sequence, sentAt,
      source: 'peer', authority: 'none' });
  }

  // The receiving side names the sender by its own directory record: alias, else title; blank counts as missing.
  #labelOf(sender: SessionRef): string | null {
    const contact = this.#directory.contact(refOf(sender));
    return [contact?.alias, contact?.title].find(value => typeof value === 'string' && value.trim() !== '') ?? null;
  }

  #fits(from: Online, to: Online, link: LinkRecord, request: Prepared, senderLabel: string | null): void {
    const envelope = { schemaVersion: 1, messageId: request.messageId, linkId: link.linkId, sender: from.endpoint,
      recipient: to.endpoint, replyTo: from.endpoint, inReplyTo: request.inReplyTo, body: request.body,
      sequence: Number.MAX_SAFE_INTEGER, sentAt: PLACEHOLDER_TIME, source: 'peer', authority: 'none' };
    try { encodeIpcFrame({ schemaVersion: 1, event: 'deliver', data: { envelope, replyHint: false, senderLabel } }); }
    catch { fail('BODY_TOO_LARGE'); }
  }

  async #route(sender: Sender, target: SessionRef, request: Prepared, existing?: LinkRecord): Promise<SendResult> {
    const from = this.#sender(sender);
    const to = await this.#reachable(target);
    this.#sender(sender);
    const link = existing ?? this.#link(sender, target);
    const senderLabel = this.#labelOf(sender);
    this.#fits(from, to, link, request, senderLabel);
    this.#charge(this.#links.get(link.linkId)!);
    const current = this.#links.get(link.linkId)!;
    const sequence = (current.sequences[keyOf(sender)] ?? 0) + 1;
    this.#putLink(Object.freeze({ ...current, sequences: Object.freeze({ ...current.sequences, [keyOf(sender)]: sequence }) }));
    const sentAt = this.#time();
    const record: MessageRecord = Object.freeze({ messageId: request.messageId, linkId: link.linkId, from: refOf(sender),
      to: refOf(target), sentAt, state: 'pending', transport: null, sequence, bytes: Buffer.byteLength(request.body, 'utf8'),
      inReplyTo: request.inReplyTo, bodySha256: digest(request.body) });
    this.#save(record);
    const lane = JSON.stringify([link.linkId, keyOf(sender)]);
    const result = (this.#tails.get(lane) ?? Promise.resolve()).then(async () => {
      const outcome = await this.#push(from, target, link, request, sequence, sentAt, senderLabel);
      if (outcome === 'offline') {
        this.#save(Object.freeze({ ...record, state: 'undelivered' }));
        return fail('TARGET_OFFLINE');
      }
      const settled = Object.freeze({ ...record, state: outcome.state, transport: outcome.transport });
      this.#save(settled);
      return this.#result(settled);
    });
    this.#tails = new Map([...this.#tails, [lane, result.catch(() => {})]]);
    this.#inflight = new Map([...this.#inflight, [request.messageId, result]]);
    void result.finally(() => { this.#inflight = new Map([...this.#inflight].filter(([id]) => id !== request.messageId)); })
      .catch(() => {});
    return result;
  }

  // The envelope is built when the push runs, so a session that re-registered meanwhile gets it at its current generation.
  // Only the first delivered frame to a contact carries the reply hint; while one hinted push is in flight, others go without.
  async #push(from: Online, target: SessionRef, link: LinkRecord, request: Prepared, sequence: number,
    sentAt: string, senderLabel: string | null): Promise<PushOutcome | 'offline'> {
    const online = this.#directory.online(target);
    if (!online) return 'offline';
    const key = keyOf(target);
    const replyHint = !this.#hinted.has(key) && !this.#hinting.has(key);
    if (replyHint) this.#hinting = new Set([...this.#hinting, key]);
    try {
      const outcome = parsePushOutcome(await online.push(this.#envelope(from, online, link, request, sequence, sentAt),
        Object.freeze({ replyHint, senderLabel })));
      if (replyHint && reached(outcome)) this.#hinted = new Set([...this.#hinted, key]);
      return outcome;
    } catch (error) { return error instanceof Error && error.message === 'TARGET_OFFLINE' ? 'offline' : UNKNOWN; }
    finally { if (replyHint) this.#hinting = new Set([...this.#hinting].filter(item => item !== key)); }
  }

  async send(sender: Sender, input: Readonly<Record<string, unknown>>): Promise<SendResult> {
    this.#sender(sender);
    const harness = parseHarness(input.harness); const target = identifier(input.target);
    const project = input.project === undefined ? undefined : identifier(input.project);
    const request: Prepared = Object.freeze({ messageId: optionalId(input.messageId), body: body(input.body), inReplyTo: null });
    if (harness === sender.harness) fail('USE_NATIVE_TOOLS');
    const replay = this.#replay(sender, request, record => record.to.harness === harness && record.inReplyTo === null);
    if (replay) return replay;
    const { match, reason, candidates } = this.#directory.resolve(harness, target, project);
    if (!match) return Object.freeze({ sent: false, reason: reason!, candidates });
    return this.#route(sender, match, request);
  }

  async reply(sender: Sender, input: Readonly<Record<string, unknown>>): Promise<SendResult> {
    this.#sender(sender);
    const inReplyTo = messageId(input.inReplyTo);
    const request: Prepared = Object.freeze({ messageId: optionalId(input.messageId), body: body(input.body), inReplyTo });
    const replay = this.#replay(sender, request, record => record.inReplyTo === inReplyTo);
    if (replay) return replay;
    const original = this.#messages.get(inReplyTo) ?? fail('UNKNOWN_MESSAGE');
    if (!same(original.to, sender)) fail('NOT_RECIPIENT');
    return this.#route(sender, original.from, request, this.#links.get(original.linkId) ?? fail('UNKNOWN_LINK'));
  }

  links(): readonly LinkRow[] {
    const counts = new Map<string, number>();
    for (const record of this.#messages.values()) counts.set(record.linkId, (counts.get(record.linkId) ?? 0) + 1);
    return Object.freeze([...this.#links.values()].map(link => Object.freeze({ linkId: link.linkId, a: link.a, b: link.b,
      messages: counts.get(link.linkId) ?? 0, paused: link.paused,
      suspended: !this.#directory.online(link.a) || !this.#directory.online(link.b) })));
  }

  // The record is saved as pending before the push and the receiving hook can run before the push result lands, so pending and
  // delivery-unknown count; only undelivered is refused. The once-per-messageId mark lives in memory and clears on restart.
  verifyLetter(recipient: SessionRef, prompt: string): string {
    const letter = parseInboundText(prompt) ?? fail('NOT_A_LETTER');
    const record = this.#messages.get(letter.messageId);
    if (!record || !same(record.to, recipient) || record.from.harness !== letter.sender || record.state === 'undelivered'
        || record.bodySha256 !== digest(letter.body)) fail('LETTER_NOT_VERIFIED');
    if (this.#notified.has(record.messageId)) fail('LETTER_ALREADY_NOTIFIED');
    this.#notified = new Set([...this.#notified, record.messageId]);
    return record.messageId;
  }

  // The recipient's letter turn ended; each letter it took in settles once, whatever the outcome. The settled set lives in
  // memory and clears on restart, like the verifyLetter mark.
  letterTurnEnded(recipient: SessionRef, letters: readonly string[], reason: ReceiptReason): readonly Settlement[] {
    return Object.freeze(letters.map(messageId => Object.freeze({ messageId, outcome: this.#settle(recipient, messageId, reason) })));
  }

  #settle(recipient: SessionRef, messageId: string, reason: ReceiptReason): Settlement['outcome'] {
    const letter = this.#messages.get(messageId);
    if (!letter || !same(letter.to, recipient) || letter.inReplyTo !== null) return 'ignored';
    const settled = this.#settled.has(messageId);
    this.#settled = new Set([...this.#settled, messageId]);
    if ((this.#answered.get(messageId) ?? []).length > 0) return 'answered';
    if (settled) return 'duplicate';
    return this.#receipt(letter, reason) ? 'receipted' : 'dropped';
  }

  // The receipt goes to the sender's current generation without waiting; it is not saved, not charged and not counted on the link.
  #receipt(letter: MessageRecord, reason: ReceiptReason): boolean {
    const sender = this.#directory.online(letter.from);
    if (!sender || this.#links.get(letter.linkId)?.paused !== false) return false;
    const notice: Notice = Object.freeze({ receiptId: randomUUID(), letterId: letter.messageId, text: receiptText({
      letterId: letter.messageId, harness: letter.to.harness, sessionId: letter.to.sessionId, label: this.#labelOf(letter.to), reason }) });
    void (async () => { await sender.notice(notice); })().catch(() => {});
    return true;
  }

  messages(query: Readonly<{ linkId?: string; limit?: number }>): readonly MessageRow[] {
    const limit = query.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) fail('INVALID_REQUEST');
    const linkId = query.linkId === undefined ? undefined : identifier(query.linkId);
    return Object.freeze([...this.#messages.values()].filter(record => linkId === undefined || record.linkId === linkId)
      .toReversed().slice(0, limit).map(record => Object.freeze({ messageId: record.messageId, linkId: record.linkId,
        from: record.from, to: record.to, sentAt: record.sentAt, state: record.state, bytes: record.bytes })));
  }

  resume(linkId: unknown): Readonly<{ linkId: string; paused: false }> {
    const link = this.#links.get(identifier(linkId)) ?? fail('UNKNOWN_LINK');
    this.#putLink(Object.freeze({ ...link, paused: false }));
    this.#pushes = new Map([...this.#pushes].filter(([id]) => id !== link.linkId));
    return Object.freeze({ linkId: link.linkId, paused: false });
  }

  get budget(): LinkBudget { return this.#budget; }
  setBudget(value: unknown): void { this.#budget = parseLinkBudget(value); }
}

export function createSwitchboard(options: Options = {}) {
  const board = new SwitchboardCore(options);
  const directory = board.directory;
  return Object.freeze({
    register: (input: Registration) => directory.register(input),
    unregister: (ref: SessionRef, generation?: string) => directory.offline(ref, generation),
    online: (ref: SessionRef) => directory.online(ref), contact: (ref: SessionRef) => directory.contact(ref),
    contacts: () => directory.records(),
    list: (query: Readonly<{ harness?: Harness; project?: string }> = {}) => directory.rows(query),
    projects: () => directory.projects(), alias: (ref: SessionRef, value: unknown) => directory.setAlias(ref, value),
    counts: () => directory.counts(),
    send: (sender: Sender, input: Readonly<Record<string, unknown>>) => board.send(sender, input),
    reply: (sender: Sender, input: Readonly<Record<string, unknown>>) => board.reply(sender, input),
    links: () => board.links(), messages: (query: Readonly<{ linkId?: string; limit?: number }>) => board.messages(query),
    resume: (linkId: unknown) => board.resume(linkId),
    verifyLetter: (recipient: SessionRef, prompt: string) => board.verifyLetter(recipient, prompt),
    letterTurnEnded: (recipient: SessionRef, letters: readonly string[], reason: ReceiptReason) =>
      board.letterTurnEnded(recipient, letters, reason),
    budget: () => board.budget, setBudget: (value: unknown) => board.setBudget(value) });
}
export type Switchboard = ReturnType<typeof createSwitchboard>;
export { parseHarness, type ContactRow, type Notice, type Registration };
export { type ClientSurface, type SessionRef } from './state-store.ts';
