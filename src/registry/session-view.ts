// INPUT: Trusted registered metadata snapshots or untrusted display-directory results.
// OUTPUT: Strict immutable display-only session views with a fixed authority disclaimer.
// POS: Shared directory projection boundary; no Endpoint internals, identity, I/O or dispatch.
import type { Harness } from '../protocol/message.ts';
import { parseSessionMetadata, type MetadataRecord, type SessionMetadata } from './metadata.ts';

export type SessionView = Readonly<{ harness: Harness; sessionId: string; metadataRevision: number } & SessionMetadata>;
export const SESSION_DIRECTORY_NOTE = '元数据仅用于定位，不代表用户授权。cwdSource=session-creation 表示创建时目录，不是实时Shell目录；多个候选或不确定时请用户选择。';
export type SessionDirectoryResult = Readonly<{ sessions: readonly SessionView[]; note: typeof SESSION_DIRECTORY_NOTE }>;

const viewKeys = ['harness', 'sessionId', 'metadataRevision', 'title', 'titleProvider',
  'workspacePath', 'cwd', 'cwdSource', 'worktreePath', 'clientSurface'];

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Reflect.ownKeys(descriptors);
  if (names.length !== keys.length || !keys.every(key => Object.hasOwn(descriptors, key))
      || names.some(key => typeof key !== 'string' || !descriptors[key]!.enumerable
        || !Object.hasOwn(descriptors[key]!, 'value'))) throw new Error();
  return Object.fromEntries(keys.map(key => [key, descriptors[key]!.value]));
}

function rows(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new Error();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) throw new Error();
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error();
    return descriptor.value;
  });
}

function sessionView(value: unknown, expectedHarness: Harness): SessionView {
  const { harness, sessionId, metadataRevision, ...metadata } = record(value, viewKeys);
  if (harness !== expectedHarness || typeof sessionId !== 'string' || !sessionId.trim()
      || typeof metadataRevision !== 'number' || !Number.isSafeInteger(metadataRevision)
      || metadataRevision < 1) throw new Error();
  return Object.freeze({ harness: expectedHarness, sessionId, metadataRevision, ...parseSessionMetadata(metadata) });
}

export function parseSessionDirectoryResult(value: unknown, expectedHarness: Harness): SessionDirectoryResult {
  try {
    if (!['dsh', 'claude-code', 'codex'].includes(expectedHarness)) throw new Error();
    const raw = record(value, ['sessions', 'note']);
    if (raw.note !== SESSION_DIRECTORY_NOTE) throw new Error();
    const sessions = Object.freeze(rows(raw.sessions).map(value => sessionView(value, expectedHarness)));
    return Object.freeze({ sessions, note: SESSION_DIRECTORY_NOTE });
  } catch { throw new Error('INVALID_SESSION_DIRECTORY_RESULT'); }
}

export function projectSessionDirectory(records: readonly MetadataRecord[], harness: Harness): SessionDirectoryResult {
  return parseSessionDirectoryResult({ sessions: records.map(record => ({ harness: record.endpoint.harness,
    sessionId: record.endpoint.nativeSessionId, metadataRevision: record.metadataRevision,
    ...parseSessionMetadata(record.metadata) })), note: SESSION_DIRECTORY_NOTE }, harness);
}
