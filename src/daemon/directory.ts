// INPUT: Persisted contact records, trusted (re)registrations with live push/verify/notice, alias edits and lookup queries.
// OUTPUT: The msd address book: per-session contacts, current online generation, project/alias rows and target resolution;
//         the Notice type (a no-reply receipt handed to the original sender's adapter).
// POS: Session-scoped directory; a contact outlives its processes, online state only lives with a current generation.
import { basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { type InboundDelivery } from '../protocol/inbound-header.ts';
import { type Endpoint, type Envelope, type Harness, type PushOutcome } from '../protocol/message.ts';
import { type ClientSurface, type ContactRecord, type SessionRef } from './state-store.ts';

// replyHint: whether this frame carries the reply guidance (a contact's first delivered message); senderLabel: the sender's
// directory alias or title here, null without either.
export type Delivery = InboundDelivery;
export type Push = (frame: Envelope, delivery: Delivery) => Promise<PushOutcome>;
// A no-reply receipt: receiptId is fresh per receipt, only for the host to dedupe and show; it is never a message.
export type Notice = Readonly<{ receiptId: string; letterId: string; text: string }>;
export type NoticePush = (notice: Notice) => Promise<void>;
export type Online = Readonly<{ generation: string; endpoint: Endpoint; push: Push; verify: () => Promise<void>; notice: NoticePush }>;
export type Registration = Readonly<SessionRef & { clientSurface: ClientSurface; title: string | null; cwd: string | null;
  project: string | null; binding?: unknown; push: Push; verify: () => Promise<void>; notice: NoticePush }>;
export type ContactRow = Readonly<SessionRef & { clientSurface: ClientSurface; title: string | null; cwd: string | null;
  project: string | null; alias: string | null; online: boolean; registeredAt: string; lastSeenAt: string }>;
export type Resolution = Readonly<{ match: ContactRecord | null; reason: 'UNKNOWN_TARGET' | 'AMBIGUOUS_TARGET' | null;
  candidates: readonly ContactRow[] }>;

export const HARNESSES: readonly Harness[] = Object.freeze(['claude-code', 'dsh', 'codex']);
const SURFACES: readonly ClientSurface[] = Object.freeze(['cli', 'desktop']);
const NAMESPACE = createHash('sha256').update('agent-message-switchboard/msd').digest('hex');

function fail(code: string): never { throw new Error(code); }
export const keyOf = (ref: SessionRef) => JSON.stringify([ref.harness, ref.sessionId]);
export const refOf = (record: SessionRef): SessionRef => Object.freeze({ harness: record.harness, sessionId: record.sessionId });

export function parseHarness(value: unknown): Harness {
  if (typeof value !== 'string' || !HARNESSES.includes(value as Harness)) fail('INVALID_HARNESS');
  return value as Harness;
}

export function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_REQUEST');
  return value;
}

function nullableText(value: unknown): string | null {
  if (value !== null && typeof value !== 'string') fail('INVALID_REQUEST');
  return value;
}

function alias(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 64 || /[\u0000-\u001f\u007f]/.test(value)) {
    fail('INVALID_REQUEST');
  }
  return value.trim();
}

const inProject = (record: ContactRecord, project: string | undefined) => project === undefined
  || (record.project !== null && (record.project === project || basename(record.project) === project));

export class Directory {
  #contacts: Map<string, ContactRecord>;
  #online = new Map<string, Online>();
  #now: () => number;
  #hostInstanceId: string;
  #persist: () => void;

  constructor(initial: readonly ContactRecord[], options: Readonly<{ now: () => number; hostInstanceId: string; persist: () => void }>) {
    this.#contacts = new Map(initial.map(record => [keyOf(record), record]));
    this.#now = options.now; this.#hostInstanceId = options.hostInstanceId; this.#persist = options.persist;
  }

  #time(): string { return new Date(this.#now()).toISOString(); }

  register(input: Registration): Online {
    const harness = parseHarness(input?.harness); const sessionId = identifier(input.sessionId);
    if (!SURFACES.includes(input.clientSurface) || typeof input.push !== 'function' || typeof input.verify !== 'function'
        || typeof input.notice !== 'function') {
      fail('INVALID_REQUEST');
    }
    const key = keyOf({ harness, sessionId }); const previous = this.#contacts.get(key); const now = this.#time();
    const record: ContactRecord = Object.freeze({ harness, sessionId, clientSurface: input.clientSurface,
      title: nullableText(input.title), cwd: nullableText(input.cwd), project: nullableText(input.project),
      alias: previous?.alias ?? null, registeredAt: previous?.registeredAt ?? now, lastSeenAt: now, binding: input.binding ?? null });
    const generation = randomUUID();
    const online: Online = Object.freeze({ generation, push: input.push, verify: input.verify, notice: input.notice,
      endpoint: Object.freeze({ schemaVersion: 1, endpointId: `${harness}:${generation}`, harness, storageNamespace: NAMESPACE,
        nativeSessionId: sessionId, hostInstanceId: this.#hostInstanceId, routeGeneration: generation }) });
    this.#contacts = new Map([...this.#contacts, [key, record]]);
    this.#online = new Map([...this.#online, [key, online]]);
    this.#persist();
    return online;
  }

  offline(ref: SessionRef, generation?: string): boolean {
    const key = keyOf({ harness: parseHarness(ref.harness), sessionId: identifier(ref.sessionId) });
    const current = this.#online.get(key);
    if (!current || (generation !== undefined && current.generation !== generation)) return false;
    this.#online = new Map([...this.#online].filter(([item]) => item !== key));
    const record = this.#contacts.get(key)!;
    this.#contacts = new Map([...this.#contacts, [key, Object.freeze({ ...record, lastSeenAt: this.#time(), binding: null })]]);
    this.#persist();
    return true;
  }

  online(ref: SessionRef): Online | undefined { return this.#online.get(keyOf(ref)); }
  contact(ref: SessionRef): ContactRecord | undefined { return this.#contacts.get(keyOf(ref)); }
  records(): readonly ContactRecord[] { return Object.freeze([...this.#contacts.values()]); }

  row(record: ContactRecord): ContactRow {
    return Object.freeze({ harness: record.harness, sessionId: record.sessionId, clientSurface: record.clientSurface,
      title: record.title, cwd: record.cwd, project: record.project, alias: record.alias,
      online: this.#online.has(keyOf(record)), registeredAt: record.registeredAt, lastSeenAt: record.lastSeenAt });
  }

  rows(query: Readonly<{ harness?: Harness; project?: string }> = {}): readonly ContactRow[] {
    const harness = query.harness === undefined ? undefined : parseHarness(query.harness);
    const project = query.project === undefined ? undefined : identifier(query.project);
    return Object.freeze([...this.#contacts.values()]
      .filter(record => (harness === undefined || record.harness === harness) && inProject(record, project))
      .map(record => this.row(record)));
  }

  projects() {
    const names = [...new Set(this.rows().map(row => row.project).filter((project): project is string => project !== null))];
    return Object.freeze(names.map(project => Object.freeze({ project, sessions: this.counts(project) })));
  }

  setAlias(ref: SessionRef, value: unknown): ContactRow {
    const key = keyOf({ harness: parseHarness(ref.harness), sessionId: identifier(ref.sessionId) });
    const record = this.#contacts.get(key) ?? fail('UNKNOWN_SESSION');
    const next = alias(value);
    if (next !== null && [...this.#contacts.values()].some(item => item.harness === record.harness
        && keyOf(item) !== key && item.alias?.toLowerCase() === next.toLowerCase())) fail('ALIAS_TAKEN');
    const updated = Object.freeze({ ...record, alias: next });
    this.#contacts = new Map([...this.#contacts, [key, updated]]);
    this.#persist();
    return this.row(updated);
  }

  resolve(harness: Harness, target: string, project?: string): Resolution {
    const scope = [...this.#contacts.values()].filter(record => record.harness === harness && inProject(record, project));
    const online = scope.filter(record => this.#online.has(keyOf(record)));
    const wanted = target.trim();
    const exact = scope.filter(record => record.sessionId === wanted);
    const aliased = scope.filter(record => record.alias !== null && record.alias.toLowerCase() === wanted.toLowerCase());
    const titled = online.filter(record => record.title !== null && record.title.trim() === wanted);
    const found = exact.length ? exact : aliased.length ? aliased : titled;
    if (found.length === 1) return Object.freeze({ match: found[0], reason: null, candidates: Object.freeze([]) });
    return Object.freeze({ match: null, reason: found.length ? 'AMBIGUOUS_TARGET' : 'UNKNOWN_TARGET',
      candidates: Object.freeze((found.length ? found : online).map(record => this.row(record))) });
  }

  counts(project?: string) {
    const count = (harness: Harness) => {
      const rows = this.rows({ harness, project });
      return Object.freeze({ online: rows.filter(row => row.online).length, offline: rows.filter(row => !row.online).length });
    };
    return Object.freeze(Object.fromEntries(HARNESSES.map(harness => [harness, count(harness)]))) as
      Readonly<Record<Harness, Readonly<{ online: number; offline: number }>>>;
  }
}
