// INPUT: The private msd state directory and directory/link/message metadata snapshots.
// OUTPUT: Strictly parsed persisted state (only an unterminated final message line is tolerated and cut), atomic 0600 rewrites, append-only metadata.
// POS: msd persistence boundary; never stores message bodies, only metadata and a body digest.
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Harness } from '../protocol/message.ts';

export type SessionRef = Readonly<{ harness: Harness; sessionId: string }>;
export type ClientSurface = 'cli' | 'desktop';
export type ContactRecord = Readonly<SessionRef & { clientSurface: ClientSurface; title: string | null; cwd: string | null;
  project: string | null; alias: string | null; registeredAt: string; lastSeenAt: string; binding: unknown }>;
export type LinkRecord = Readonly<{ linkId: string; a: SessionRef; b: SessionRef; createdAt: string; paused: boolean;
  sequences: Readonly<Record<string, number>> }>;
export type MessageState = 'pending' | 'dispatched' | 'delivery-unknown' | 'undelivered';
export type MessageRecord = Readonly<{ messageId: string; linkId: string; from: SessionRef; to: SessionRef; sentAt: string;
  state: MessageState; transport: 'written' | null; sequence: number; bytes: number; inReplyTo: string | null; bodySha256: string }>;
export type PersistedState = Readonly<{ contacts: readonly ContactRecord[]; links: readonly LinkRecord[];
  messages: readonly MessageRecord[] }>;
export type StateStore = Readonly<{ load: () => PersistedState;
  saveDirectory: (contacts: readonly ContactRecord[], links: readonly LinkRecord[]) => void;
  appendMessage: (record: MessageRecord) => void }>;

const HARNESSES = ['claude-code', 'dsh', 'codex'];
function fail(): never { throw new Error('STATE_UNREADABLE'); }

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).length !== keys.length || !keys.every(key => Object.hasOwn(raw, key))) fail();
  return raw;
}
const text = (value: unknown) => typeof value === 'string' && value.trim() !== '';
const nullable = (value: unknown) => value === null || typeof value === 'string';
const time = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));

function ref(value: unknown): SessionRef {
  const raw = object(value, ['harness', 'sessionId']);
  if (!HARNESSES.includes(raw.harness as string) || !text(raw.sessionId)) fail();
  return Object.freeze({ harness: raw.harness as Harness, sessionId: raw.sessionId as string });
}

function contact(value: unknown): ContactRecord {
  const raw = object(value, ['harness', 'sessionId', 'clientSurface', 'title', 'cwd', 'project', 'alias', 'registeredAt',
    'lastSeenAt', 'binding']);
  ref({ harness: raw.harness, sessionId: raw.sessionId });
  if (!['cli', 'desktop'].includes(raw.clientSurface as string) || ![raw.title, raw.cwd, raw.project, raw.alias].every(nullable)
      || !time(raw.registeredAt) || !time(raw.lastSeenAt)) fail();
  return Object.freeze({ ...raw }) as ContactRecord;
}

function link(value: unknown): LinkRecord {
  const raw = object(value, ['linkId', 'a', 'b', 'createdAt', 'paused', 'sequences']);
  const sequences = raw.sequences as Record<string, unknown>;
  if (!text(raw.linkId) || !time(raw.createdAt) || typeof raw.paused !== 'boolean' || !sequences
      || typeof sequences !== 'object' || Array.isArray(sequences)
      || Object.values(sequences).some(item => !Number.isSafeInteger(item) || (item as number) < 0)) fail();
  return Object.freeze({ linkId: raw.linkId as string, a: ref(raw.a), b: ref(raw.b), createdAt: raw.createdAt as string,
    paused: raw.paused, sequences: Object.freeze({ ...sequences }) as Record<string, number> });
}

function message(value: unknown): MessageRecord {
  const raw = object(value, ['messageId', 'linkId', 'from', 'to', 'sentAt', 'state', 'transport', 'sequence', 'bytes',
    'inReplyTo', 'bodySha256']);
  if (!text(raw.messageId) || !text(raw.linkId) || !time(raw.sentAt)
      || !['pending', 'dispatched', 'delivery-unknown', 'undelivered'].includes(raw.state as string)
      || (raw.transport !== null && raw.transport !== 'written') || !Number.isSafeInteger(raw.sequence)
      || !Number.isSafeInteger(raw.bytes) || !nullable(raw.inReplyTo)
      || typeof raw.bodySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(raw.bodySha256)) fail();
  return Object.freeze({ ...raw, from: ref(raw.from), to: ref(raw.to) }) as MessageRecord;
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.uid !== process.getuid!() || (info.mode & 0o077) !== 0) fail();
}

function privateFile(path: string): boolean {
  if (!existsSync(path)) return false;
  const info = lstatSync(path);
  if (!info.isFile() || info.uid !== process.getuid!() || (info.mode & 0o077) !== 0) fail();
  return true;
}

export function createStateStore(directory: string): StateStore {
  const directoryPath = join(directory, 'directory.json');
  const messagesPath = join(directory, 'messages.jsonl');
  privateDirectory(directory);
  return Object.freeze({
    load: () => {
      let contacts: ContactRecord[] = []; let links: LinkRecord[] = [];
      if (privateFile(directoryPath)) {
        let raw: Record<string, unknown>;
        try { raw = object(JSON.parse(readFileSync(directoryPath, 'utf8')), ['schemaVersion', 'contacts', 'links']); }
        catch { return fail(); }
        if (raw.schemaVersion !== 1 || !Array.isArray(raw.contacts) || !Array.isArray(raw.links)) fail();
        contacts = raw.contacts.map(contact); links = raw.links.map(link);
      }
      const messages = new Map<string, MessageRecord>();
      if (privateFile(messagesPath)) {
        const text = readFileSync(messagesPath, 'utf8');
        const complete = text.slice(0, text.lastIndexOf('\n') + 1);
        for (const line of complete.split('\n').slice(0, -1)) {
          let record: MessageRecord;
          try { record = message(JSON.parse(line)); } catch { return fail(); }
          messages.set(record.messageId, record);
        }
        // Only an unterminated final append is torn; cut it so the next append starts on a clean line.
        if (complete.length < text.length) truncateSync(messagesPath, Buffer.byteLength(complete, 'utf8'));
      }
      return Object.freeze({ contacts: Object.freeze(contacts), links: Object.freeze(links),
        messages: Object.freeze([...messages.values()]) });
    },
    saveDirectory: (contacts, links) => {
      const temporary = join(directory, `.directory-${randomUUID()}.tmp`);
      try {
        writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, contacts, links }), { flag: 'wx', mode: 0o600 });
        renameSync(temporary, directoryPath);
      } catch { rmSync(temporary, { force: true }); throw new Error('STATE_WRITE_FAILED'); }
    },
    appendMessage: record => {
      try { appendFileSync(messagesPath, JSON.stringify(record) + '\n', { mode: 0o600 }); }
      catch { throw new Error('STATE_WRITE_FAILED'); }
    },
  });
}

export function createMemoryStore(initial?: PersistedState): StateStore & Readonly<{ snapshot: () => PersistedState }> {
  let state: PersistedState = initial ?? Object.freeze({ contacts: [], links: [], messages: [] });
  return Object.freeze({ load: () => state, snapshot: () => state,
    saveDirectory: (contacts: readonly ContactRecord[], links: readonly LinkRecord[]) => {
      state = Object.freeze({ ...state, contacts: Object.freeze([...contacts]), links: Object.freeze([...links]) });
    },
    appendMessage: (record: MessageRecord) => {
      state = Object.freeze({ ...state, messages: Object.freeze([...state.messages.filter(item => item.messageId !== record.messageId), record]) });
    } });
}
