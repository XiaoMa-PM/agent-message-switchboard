// INPUT: Owned child bytes, trusted inspect/quiesce controls and synchronous reply-written observer.
// OUTPUT: Strict correlated controls (inspect / inspect-signed), compact or daily hook-output replies, post-write notification and fail-closed reads.
// POS: Pure stdio RPC scheduler; parsing evidence does not authenticate a process or sender.
import { type CodeSigner, type KernelPeer, type ProcessSnapshot, type SignedSnapshot } from '../adapters/claude/peer-identity.ts';
import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CLAUDE_DELIVERY_NOTES, type ClaudeChannelResult, type PreparedResult } from './claude-channel.ts';
import { parsePushOutcome } from '../protocol/message.ts';
import { createIpcDecoder, encodeIpcFrame } from './ipc-frame.ts';
import { parseSessionDirectoryResult } from '../registry/session-view.ts';
import { parseDailyHookResult, type DailyHookResult } from './hook-output.ts';

export type StdioRequest = Readonly<{ schemaVersion: 1; requestId: string; peer: KernelPeer;
  snapshots: readonly (readonly ProcessSnapshot[])[]; payload: unknown }>;
export type ReplyWritten = Readonly<{ requestId: string; ok: boolean }>;
export type QuiesceResult = Readonly<{ drained: true }>;
type Options = Readonly<{ handle: (request: StdioRequest) => Promise<ClaudeChannelResult | PreparedResult | DailyHookResult>;
  write: (frame: Buffer) => void | Promise<void>; close: (code: string) => void; onReplyWritten?: (reply: ReplyWritten) => void }>;
type StdioRpc = Readonly<{ push: (chunk: Uint8Array) => void; end: () => void; close: () => void;
  whenClosed: Promise<string>; quiesce: () => Promise<QuiesceResult>; drain: () => Promise<void>; inspect: (pid: number) => Promise<ProcessSnapshot>;
  inspectSigned: (pid: number) => Promise<SignedSnapshot> }>;
type Result = ClaudeChannelResult | PreparedResult | DailyHookResult;
type Operation = 'inspect' | 'inspect-signed';
type Control = Readonly<{ pid: number; operation: Operation; promise: Promise<ProcessSnapshot & SignedSnapshot>;
  resolve: (value: ProcessSnapshot & SignedSnapshot) => void; reject: (error: Error) => void }>;
const controlErrors = new Set(['PROCESS_IDENTITY_UNAVAILABLE', 'INVALID_PROCESS_IDENTITY',
  'INVALID_PROCESS_PATH', 'UNTRUSTED_EXECUTABLE', 'CODE_SIGNING_UNAVAILABLE', 'IPC_REQUEST_FAILED']);
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const errors = new Set(['IPC_FRAME_TOO_LARGE', 'CLAUDE_CHANNEL_UNAVAILABLE', 'CLAUDE_CHANNEL_DELIVERY_UNKNOWN',
  'CLAUDE_CHANNEL_PREFLIGHT_FAILED', 'INVALID_SKILL_INVOCATION', 'SKILL_SOURCE_MISMATCH', 'SKILL_PRE_MISSING',
  'SKILL_INVOCATION_CONFLICT', 'SESSION_EPOCH_REVOKED', 'INVALID_EPOCH_BINDING', 'INVALID_EPOCH_IDENTITY',
  'INVALID_PEER_IDENTITY', 'UNSUPPORTED_PEER_ANCESTRY', 'UNSUPPORTED_CLAUDE_BINARY', 'UNKNOWN_TARGET',
  'AMBIGUOUS_TARGET', 'UNKNOWN_LINK', 'UNKNOWN_MESSAGE', 'NOT_A_MEMBER', 'NOT_RECIPIENT', 'INVALID_DSH_SOURCE',
  'INVALID_TARGET', 'INVALID_BRIDGE_REQUEST', 'ROUNDTRIP_STOPPED',
  'METADATA_QUERY_UNAVAILABLE', 'METADATA_QUERY_FAILED', 'METADATA_CONTEXT_TOO_LARGE']);

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_IPC_REQUEST');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('INVALID_IPC_REQUEST');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Reflect.ownKeys(descriptors);
  if (names.length !== keys.length || !keys.every(key => Object.hasOwn(descriptors, key))
      || names.some(key => typeof key !== 'string' || !descriptors[key].enumerable
        || !Object.hasOwn(descriptors[key], 'value'))) throw new Error('INVALID_IPC_REQUEST');
  return value as Record<string, unknown>;
}

function number(value: unknown, minimum = 0, maximum = 0xffffffff): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error('INVALID_IPC_REQUEST');
  }
  return value;
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('INVALID_IPC_REQUEST');
  return value;
}

function unique(value: unknown): string {
  const result = text(value);
  if (!/^[1-9][0-9]{0,19}$/.test(result) || BigInt(result) > 0xffffffffffffffffn) throw new Error('INVALID_IPC_REQUEST');
  return result;
}

function peer(value: unknown): KernelPeer {
  const raw = record(value, ['pid', 'uid', 'pidVersion']);
  return Object.freeze({ pid: number(raw.pid, 2, 0x7fffffff), uid: number(raw.uid), pidVersion: number(raw.pidVersion) });
}

function snapshot(value: unknown): ProcessSnapshot {
  const raw = record(value, ['pid', 'uid', 'pidVersion', 'uniqueId', 'parentPid', 'parentUniqueId', 'exe', 'sha256']);
  const exe = text(raw.exe); const sha256 = text(raw.sha256);
  if (!isAbsolute(exe) || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('INVALID_IPC_REQUEST');
  return Object.freeze({ pid: number(raw.pid, 2, 0x7fffffff), uid: number(raw.uid), pidVersion: number(raw.pidVersion),
    uniqueId: unique(raw.uniqueId), parentPid: number(raw.parentPid, 1, 0x7fffffff),
    parentUniqueId: unique(raw.parentUniqueId), exe, sha256 });
}

function signer(value: unknown): CodeSigner | null {
  if (value === null) return null;
  const raw = record(value, ['teamId', 'identifier', 'runtime']);
  if (typeof raw.teamId !== 'string' || !/^[A-Z0-9]{10}$/.test(raw.teamId) || typeof raw.identifier !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/.test(raw.identifier) || typeof raw.runtime !== 'boolean') throw new Error('INVALID_IPC_REQUEST');
  return Object.freeze({ teamId: raw.teamId, identifier: raw.identifier, runtime: raw.runtime });
}

function signedSnapshot(value: unknown): SignedSnapshot {
  const raw = record(value, ['pid', 'uid', 'pidVersion', 'uniqueId', 'parentPid', 'parentUniqueId', 'exe', 'sha256', 'signing']);
  const exe = text(raw.exe); const signing = signer(raw.signing);
  const sha256 = raw.sha256 === null ? null : text(raw.sha256);
  if (!isAbsolute(exe) || (sha256 === null) === (signing === null) || (sha256 !== null && !/^[a-f0-9]{64}$/.test(sha256))) {
    throw new Error('INVALID_IPC_REQUEST');
  }
  return Object.freeze({ pid: number(raw.pid, 2, 0x7fffffff), uid: number(raw.uid), pidVersion: number(raw.pidVersion),
    uniqueId: unique(raw.uniqueId), parentPid: number(raw.parentPid, 1, 0x7fffffff),
    parentUniqueId: unique(raw.parentUniqueId), exe, sha256, signing });
}

function freezePayload(value: unknown): unknown {
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (item && typeof item === 'object') { for (const child of Object.values(item)) pending.push(child); Object.freeze(item); }
  }
  return value;
}

function request(value: unknown): StdioRequest {
  const raw = record(value, ['schemaVersion', 'requestId', 'peer', 'snapshots', 'payload']);
  if (raw.schemaVersion !== 1 || typeof raw.requestId !== 'string' || !uuid.test(raw.requestId)
      || !Array.isArray(raw.snapshots) || raw.snapshots.length !== 2) throw new Error('INVALID_IPC_REQUEST');
  const snapshots = raw.snapshots.map(pass => {
    if (!Array.isArray(pass) || pass.length === 0) throw new Error('INVALID_IPC_REQUEST');
    return Object.freeze(pass.map(snapshot));
  });
  return Object.freeze({ schemaVersion: 1, requestId: raw.requestId, peer: peer(raw.peer),
    snapshots: Object.freeze(snapshots), payload: freezePayload(raw.payload) });
}

function compactResult(value: unknown): Result {
  if (!value || typeof value !== 'object') throw new Error('INVALID_IPC_RESULT');
  if (Object.hasOwn(value, 'hookOutput')) return parseDailyHookResult(value);
  if (Object.hasOwn(value, 'sessions')) return parseSessionDirectoryResult(value, 'dsh');
  if (Object.hasOwn(value, 'prepared')) {
    const raw = record(value, ['prepared']);
    if (raw.prepared !== true) throw new Error('INVALID_IPC_RESULT');
    return Object.freeze({ prepared: true });
  }
  if (Object.hasOwn(value, 'linkId')) {
    const raw = record(value, ['linkId', 'targetSessionId']);
    return Object.freeze({ linkId: text(raw.linkId), targetSessionId: text(raw.targetSessionId) });
  }
  const raw = record(value, ['receipt', 'deliveryNote']);
  const receipt = record(raw.receipt, ['messageId', 'state', 'transport', 'sequence', 'linkId', 'targetSessionId']);
  const outcome = parsePushOutcome({ state: receipt.state, transport: receipt.transport });
  const note = outcome.state === 'dispatched' ? CLAUDE_DELIVERY_NOTES.dispatched
    : outcome.transport === 'written' ? CLAUDE_DELIVERY_NOTES.written : CLAUDE_DELIVERY_NOTES.unknown;
  if (raw.deliveryNote !== note) throw new Error('INVALID_IPC_RESULT');
  return Object.freeze({ receipt: Object.freeze({ messageId: text(receipt.messageId),
    ...outcome,
    sequence: number(receipt.sequence, 1, Number.MAX_SAFE_INTEGER), linkId: text(receipt.linkId),
    targetSessionId: text(receipt.targetSessionId) }), deliveryNote: raw.deliveryNote as string });
}

function errorCode(error: unknown): string {
  return error instanceof Error && errors.has(error.message) ? error.message : 'IPC_REQUEST_FAILED';
}

function framingError(error: unknown): string {
  const codes = ['IPC_FRAME_INVALID', 'IPC_FRAME_TOO_LARGE', 'IPC_FRAME_EOF', 'IPC_DECODER_FAILED', 'IPC_DECODER_CLOSED'];
  return error instanceof Error && codes.includes(error.message) ? error.message : 'IPC_REQUEST_FAILED';
}

class OwnedStdioRpc {
  #options: Options;
  #decoder = createIpcDecoder();
  #seen = new Set<string>();
  #controls = new Map<string, Control>();
  #quiesce?: Readonly<{ requestId: string; resolve: (result: QuiesceResult) => void; reject: (error: Error) => void }>;
  #quiesceState: 'open' | 'quiescing' | 'drained' | 'failed' = 'open';
  #pending = new Set<Promise<void>>();
  #tail = Promise.resolve();
  #closed = false;
  #completion = Promise.withResolvers<string>();

  constructor(options: Options) {
    if ([options.handle, options.write, options.close].some(fn => typeof fn !== 'function')
      || (options.onReplyWritten !== undefined && typeof options.onReplyWritten !== 'function')) {
      throw new Error('INVALID_IPC_CALLBACKS');
    }
    this.#options = Object.freeze({ ...options });
  }

  get whenClosed(): Promise<string> { return this.#completion.promise; }

  #shutdown(code: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#completion.resolve(code);
    for (const control of this.#controls.values()) control.reject(new Error(code));
    this.#controls = new Map();
    this.#quiesce?.reject(new Error(code)); this.#quiesce = undefined;
    try { void Promise.resolve(this.#options.close(code)).catch(() => {}); }
    catch { /* Owned teardown failures cannot reopen the channel or expose raw data. */ }
  }

  push(chunk: Uint8Array): void {
    if (this.#closed) throw new Error('IPC_DECODER_CLOSED');
    let values: unknown[];
    try { values = this.#decoder.push(chunk); }
    catch (error) {
      const code = framingError(error);
      this.#shutdown(code); throw new Error(code);
    }
    for (const value of values) {
      if (value && typeof value === 'object' && Object.hasOwn(value, 'operation')) {
        this.#controlReply(value); continue;
      }
      let parsed: StdioRequest;
      try {
        parsed = request(value);
        if (this.#seen.has(parsed.requestId)) throw new Error('INVALID_IPC_REQUEST');
      } catch { this.#shutdown('INVALID_IPC_REQUEST'); throw new Error('INVALID_IPC_REQUEST'); }
      this.#seen = new Set([...this.#seen, parsed.requestId]);
      this.#start(parsed);
    }
  }

  inspect(pid: number): Promise<ProcessSnapshot> { return this.#control(pid, 'inspect'); }

  inspectSigned(pid: number): Promise<SignedSnapshot> { return this.#control(pid, 'inspect-signed'); }

  #control(pid: number, operation: Operation): Promise<ProcessSnapshot & SignedSnapshot> {
    if (this.#closed) return Promise.reject(new Error('IPC_DECODER_CLOSED'));
    if (this.#quiesceState === 'drained' || this.#quiesceState === 'failed') return Promise.reject(new Error('INVALID_IPC_CONTROL'));
    try { number(pid, 2, 0x7fffffff); }
    catch { return Promise.reject(new Error('INVALID_IPC_CONTROL')); }
    const requestId = randomUUID();
    const pending = Promise.withResolvers<ProcessSnapshot & SignedSnapshot>();
    this.#controls = new Map([...this.#controls, [requestId, Object.freeze({ pid, operation, ...pending })]]);
    void this.#write(encodeIpcFrame({ schemaVersion: 1, requestId, operation, pid }));
    return pending.promise;
  }

  quiesce(): Promise<QuiesceResult> {
    if (this.#closed) return Promise.reject(new Error('IPC_DECODER_CLOSED'));
    if (this.#quiesceState !== 'open') return Promise.reject(new Error('INVALID_IPC_CONTROL'));
    this.#quiesceState = 'quiescing';
    const requestId = randomUUID(); const pending = Promise.withResolvers<QuiesceResult>();
    void pending.promise.catch(() => {});
    this.#quiesce = Object.freeze({ requestId, resolve: pending.resolve, reject: pending.reject });
    void this.#write(encodeIpcFrame({ schemaVersion: 1, operation: 'quiesce', requestId }));
    return pending.promise;
  }

  #quiesceReply(value: unknown): void {
    const ok = (value as Record<string, unknown>).ok;
    const raw = record(value, ['schemaVersion', 'operation', 'requestId', 'ok', ok === true ? 'result' : 'error']);
    const pending = this.#quiesce;
    if (raw.schemaVersion !== 1 || raw.operation !== 'quiesce' || !pending
      || raw.requestId !== pending.requestId || this.#quiesceState !== 'quiescing') throw new Error('INVALID_IPC_CONTROL');
    if (ok === true) {
      const result = record(raw.result, ['drained']);
      if (result.drained !== true) throw new Error('INVALID_IPC_CONTROL');
      this.#quiesce = undefined; this.#quiesceState = 'drained';
      pending.resolve(Object.freeze({ drained: true }));
    } else {
      if (ok !== false || raw.error !== 'IPC_REQUEST_FAILED') throw new Error('INVALID_IPC_CONTROL');
      this.#quiesce = undefined; this.#quiesceState = 'failed';
      pending.reject(new Error('IPC_REQUEST_FAILED'));
    }
  }

  #controlReply(value: unknown): void {
    try {
      if ((value as Record<string, unknown>).operation === 'quiesce') { this.#quiesceReply(value); return; }
      const ok = (value as Record<string, unknown>).ok;
      const raw = record(value, ['schemaVersion', 'requestId', 'operation', 'ok', ok === true ? 'snapshot' : 'error']);
      if (raw.schemaVersion !== 1 || typeof raw.requestId !== 'string' || !uuid.test(raw.requestId)) throw new Error('INVALID_IPC_CONTROL');
      const pending = this.#controls.get(raw.requestId);
      if (!pending || raw.operation !== pending.operation) throw new Error('INVALID_IPC_CONTROL');
      if (ok === true) {
        const current = (pending.operation === 'inspect' ? snapshot(raw.snapshot) : signedSnapshot(raw.snapshot)) as
          ProcessSnapshot & SignedSnapshot;
        if (current.pid !== pending.pid) throw new Error('INVALID_IPC_CONTROL');
        this.#controls = new Map([...this.#controls].filter(([id]) => id !== raw.requestId));
        pending.resolve(current);
      } else {
        if (ok !== false || typeof raw.error !== 'string' || !controlErrors.has(raw.error)) {
          throw new Error('INVALID_IPC_CONTROL');
        }
        this.#controls = new Map([...this.#controls].filter(([id]) => id !== raw.requestId));
        pending.reject(new Error(raw.error));
      }
    } catch { this.#shutdown('INVALID_IPC_CONTROL'); throw new Error('INVALID_IPC_CONTROL'); }
  }

  #start(parsed: StdioRequest): void {
    const pending = Promise.resolve().then(() => this.#perform(parsed));
    this.#pending = new Set([...this.#pending, pending]);
    void pending.then(() => this.#pending.delete(pending), () => {
      this.#pending.delete(pending); this.#shutdown('IPC_REQUEST_FAILED');
    });
  }

  async #perform(parsed: StdioRequest): Promise<void> {
    if (this.#closed) return;
    let response: { schemaVersion: number; requestId: string; ok: boolean; result?: Result; error?: string };
    try {
      const result = await this.#options.handle(parsed);
      if (this.#closed) return;
      let compact: Result;
      try { compact = compactResult(result); }
      catch { throw new Error('IPC_REQUEST_FAILED'); }
      response = { schemaVersion: 1, requestId: parsed.requestId, ok: true, result: compact };
    } catch (error) {
      if (this.#closed) return;
      response = { schemaVersion: 1, requestId: parsed.requestId, ok: false, error: errorCode(error) };
    }
    let frame: Buffer;
    try { frame = encodeIpcFrame(response); }
    catch (error) {
      response = { schemaVersion: 1, requestId: parsed.requestId, ok: false, error: errorCode(error) };
      frame = encodeIpcFrame(response);
    }
    await this.#write(frame, Object.freeze({ requestId: parsed.requestId, ok: response.ok }));
  }

  #write(frame: Buffer, reply?: ReplyWritten): Promise<void> {
    this.#tail = this.#tail.then(async () => {
      if (this.#closed) return;
      try {
        await this.#options.write(frame);
        if (!this.#closed && reply) this.#options.onReplyWritten?.(reply);
      }
      catch { this.#shutdown('IPC_WRITE_FAILED'); }
    });
    return this.#tail;
  }

  end(): void {
    if (this.#closed) throw new Error('IPC_DECODER_CLOSED');
    try { this.#decoder.end(); }
    catch (error) {
      const code = framingError(error);
      this.#shutdown(code); throw new Error(code);
    }
    this.#shutdown('IPC_DECODER_CLOSED');
  }

  close(): void { this.#shutdown('IPC_DECODER_CLOSED'); }
  async drain(): Promise<void> { await Promise.allSettled([...this.#pending, ...[...this.#controls.values()].map(value => value.promise)]); }
}

export function createStdioRpc(options: Options): StdioRpc {
  const rpc = new OwnedStdioRpc(options);
  return Object.freeze({ push: (chunk: Uint8Array) => rpc.push(chunk), end: () => rpc.end(), close: () => rpc.close(),
    whenClosed: rpc.whenClosed, quiesce: () => rpc.quiesce(), drain: () => rpc.drain(), inspect: (pid: number) => rpc.inspect(pid),
    inspectSigned: (pid: number) => rpc.inspectSigned(pid) });
}
