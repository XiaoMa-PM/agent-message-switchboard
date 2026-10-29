// INPUT: Owned-stdio callback fixtures, synthetic system evidence and fragmented IPC frames.
// OUTPUT: Strict directories, request correlation, serialized writes and closed-channel regressions.
// POS: Pure RPC scheduler tests; parsed peer data is never authentication evidence.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeIpcFrame, createIpcDecoder, MAX_FRAME_BYTES } from '../../src/bridge/ipc-frame.ts';
import { CLAUDE_DELIVERY_NOTES, type ClaudeChannelResult, type PreparedResult } from '../../src/bridge/claude-channel.ts';
import { createStdioRpc, type StdioRequest } from '../../src/bridge/stdio-rpc.ts';
import { SESSION_DIRECTORY_NOTE, type SessionDirectoryResult } from '../../src/registry/session-view.ts';

type Result = ClaudeChannelResult | PreparedResult;
const id = (index: number) => `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`;
const snapshot = { pid: 50, uid: 501, pidVersion: 2, uniqueId: '500', parentPid: 40,
  parentUniqueId: '400', exe: '/synthetic/python', sha256: 'a'.repeat(64) };
function request(index = 1, payload: unknown = { event: 'synthetic' }) {
  return { schemaVersion: 1, requestId: id(index), peer: { pid: 50, uid: 501, pidVersion: 2 },
    snapshots: [[snapshot], [snapshot]], payload };
}
const prepared = Object.freeze({ prepared: true } as const);
const connect = Object.freeze({ linkId: id(77), targetSessionId: 'original-dsh' });
const receipt: ClaudeChannelResult = { receipt: { messageId: 'original-message', state: 'delivery-unknown',
  transport: 'written', sequence: 1, linkId: id(77), targetSessionId: 'original-dsh' },
  deliveryNote: CLAUDE_DELIVERY_NOTES.written };

function decode(frames: readonly Buffer[]): Array<Record<string, unknown>> {
  const decoder = createIpcDecoder();
  const values = decoder.push(Buffer.concat(frames)); decoder.end();
  return values as Array<Record<string, unknown>>;
}

function fixture(handle: (request: StdioRequest) => Promise<Result> = async () => prepared,
  write?: (frame: Buffer) => void | Promise<void>) {
  const calls: StdioRequest[] = []; const frames: Buffer[] = []; const reasons: string[] = [];
  const rpc = createStdioRpc({ handle: async input => { calls.push(input); return handle(input); },
    write: async frame => { frames.push(Buffer.from(frame)); await write?.(frame); },
    close: code => { reasons.push(code); } });
  return { rpc, calls, frames, reasons };
}

test('prepared connect and compact receipt use complete correlated response wrappers', async () => {
  const expected = [prepared, connect, receipt]; let index = 0;
  const f = fixture(async () => expected[index++]);
  f.rpc.push(Buffer.concat(expected.map((_, i) => encodeIpcFrame(request(i + 1)))));
  await f.rpc.drain();
  assert.deepEqual(decode(f.frames), expected.map((result, i) => ({ schemaVersion: 1, requestId: id(i + 1), ok: true, result })));
  assert.equal(f.reasons.length, 0);
});

test('every split in prefix or Unicode payload yields one complete request', async () => {
  const value = request(1, { body: '中文😀\n$HOME $(echo marker)' }); const frame = encodeIpcFrame(value);
  for (const split of [1, 2, 3, 4, frame.indexOf(Buffer.from('😀')) + 1, frame.length - 1]) {
    const f = fixture(); f.rpc.push(frame.subarray(0, split)); assert.equal(f.calls.length, 0);
    f.rpc.push(frame.subarray(split)); await f.rpc.drain();
    assert.deepEqual(f.calls, [value]); assert.equal(f.frames.length, 1);
  }
});

test('system-shaped fields are frozen but identity consistency remains the host callback responsibility', async () => {
  const value = { ...request(), peer: { pid: 99, uid: 0, pidVersion: 5 },
    snapshots: [[{ ...snapshot, pid: 50 }], [{ ...snapshot, pid: 60 }]], payload: { source: 'not-authority' } };
  const f = fixture(async input => {
    assert.ok(Object.isFrozen(input)); assert.ok(Object.isFrozen(input.peer));
    assert.ok(Object.isFrozen(input.snapshots)); assert.ok(Object.isFrozen(input.snapshots[0]));
    assert.ok(Object.isFrozen(input.snapshots[0][0])); assert.ok(Object.isFrozen(input.payload));
    assert.equal(input.peer.pid, 99); throw new Error('INVALID_PEER_IDENTITY');
  });
  f.rpc.push(encodeIpcFrame(value)); await f.rpc.drain();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(decode(f.frames), [{ schemaVersion: 1, requestId: id(1), ok: false, error: 'INVALID_PEER_IDENTITY' }]);
});

test('payload passes through lifecycle and Skill data without choosing their semantics', async () => {
  const payloads = [{ hook_event_name: 'SessionStart', source: 'startup' },
    { hook_event_name: 'PostToolUse', tool_name: 'Skill' }, 'unknown-data'];
  const f = fixture();
  f.rpc.push(Buffer.concat(payloads.map((payload, i) => encodeIpcFrame(request(i + 1, payload)))));
  await f.rpc.drain(); assert.deepEqual(f.calls.map(call => call.payload), payloads);
});

test('large valid JSON arrays do not fail because of argument-spread limits', async () => {
  const payload = Array.from({ length: 200000 }, () => 0);
  const f = fixture(); const frame = encodeIpcFrame(request(1, payload));
  assert.ok(frame.length < MAX_FRAME_BYTES);
  f.rpc.push(frame); await f.rpc.drain();
  assert.equal((f.calls[0].payload as unknown[]).length, payload.length);
  assert.equal(f.frames.length, 1);
});

test('duplicate request ID permanently closes without another handler or late response', async () => {
  const entered = Promise.withResolvers<void>(); const gate = Promise.withResolvers<Result>();
  const f = fixture(async () => { entered.resolve(); return gate.promise; });
  f.rpc.push(encodeIpcFrame(request())); await entered.promise;
  assert.throws(() => f.rpc.push(encodeIpcFrame(request())), /^Error: INVALID_IPC_REQUEST$/);
  assert.equal(await f.rpc.whenClosed, 'INVALID_IPC_REQUEST');
  assert.deepEqual(f.reasons, ['INVALID_IPC_REQUEST']);
  assert.throws(() => f.rpc.push(encodeIpcFrame(request(2))), /^Error: IPC_DECODER_CLOSED$/);
  gate.resolve(prepared); await f.rpc.drain();
  assert.equal(f.calls.length, 1); assert.equal(f.frames.length, 0);
});

test('invalid UUID, fields and two-pass evidence close before calling the host', async () => {
  const valid = request();
  const invalid = [{ ...valid, requestId: 'not-a-UUID' }, { ...valid, requestId: ' ' + id(1) },
    { ...valid, requestId: id(1).toUpperCase().replace('000000000001', 'ABCDEFABCDEF') },
    { ...valid, schemaVersion: 2 }, { ...valid, from: 'forged' },
    { ...valid, peer: { ...valid.peer, authority: 'user' } }, { ...valid, peer: { ...valid.peer, uid: -1 } },
    { ...valid, snapshots: [[snapshot]] }, { ...valid, snapshots: [[], []] },
    { ...valid, snapshots: [[{ ...snapshot, uniqueId: 500 }], [snapshot]] },
    { ...valid, snapshots: [[{ ...snapshot, sha256: 'wrong' }], [snapshot]] },
    { ...valid, snapshots: [[{ ...snapshot, extra: true }], [snapshot]] }];
  for (const value of invalid) {
    const f = fixture();
    assert.throws(() => f.rpc.push(encodeIpcFrame(value)), /^Error: INVALID_IPC_REQUEST$/);
    await f.rpc.drain(); assert.equal(f.calls.length, 0); assert.equal(f.frames.length, 0);
    assert.equal(await f.rpc.whenClosed, 'INVALID_IPC_REQUEST');
  }
});

test('a bad request stops not-yet-started calls in the same stdout chunk', async () => {
  const f = fixture();
  const frames = [request(), { ...request(2), unexpected: 'private' }, request(3)].map(encodeIpcFrame);
  assert.throws(() => f.rpc.push(Buffer.concat(frames)), /^Error: INVALID_IPC_REQUEST$/);
  await f.rpc.drain(); assert.equal(f.calls.length, 0); assert.equal(f.frames.length, 0);
});

test('independent handlers run concurrently and preserve response request IDs', async () => {
  const gates = [Promise.withResolvers<Result>(), Promise.withResolvers<Result>()];
  const started = Promise.withResolvers<void>(); let count = 0;
  const f = fixture(async input => { if (++count === 2) started.resolve(); return gates[input.requestId === id(1) ? 0 : 1].promise; });
  f.rpc.push(Buffer.concat([encodeIpcFrame(request()), encodeIpcFrame(request(2))]));
  await started.promise; assert.equal(f.calls.length, 2);
  gates[1].resolve(connect); await Promise.resolve(); await Promise.resolve();
  gates[0].resolve(prepared); await f.rpc.drain();
  assert.deepEqual(decode(f.frames).map(response => response.requestId), [id(2), id(1)]);
});

test('write callbacks receive whole frames serially without byte interleaving', async () => {
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  let writes = 0; let active = 0; let maximum = 0;
  const f = fixture(async () => prepared, async frame => {
    assert.equal(frame.readUInt32BE(0), frame.length - 4);
    active += 1; maximum = Math.max(maximum, active);
    if (++writes === 1) { entered.resolve(); await release.promise; }
    active -= 1;
  });
  f.rpc.push(Buffer.concat([encodeIpcFrame(request()), encodeIpcFrame(request(2))]));
  await entered.promise; assert.equal(f.calls.length, 2); assert.equal(f.frames.length, 1);
  release.resolve(); await f.rpc.drain();
  assert.equal(f.frames.length, 2); assert.equal(maximum, 1); assert.equal(active, 0);
});

test('handler exceptions only emit whitelisted short codes and never raw messages', async () => {
  for (const [error, code] of [[new Error('private/path body credentials'), 'IPC_REQUEST_FAILED'],
    [new Error('SECRET_BODY'), 'IPC_REQUEST_FAILED'], [new Error('IPC_FRAME_TOO_LARGE'), 'IPC_FRAME_TOO_LARGE'],
    [new Error('SKILL_PRE_MISSING'), 'SKILL_PRE_MISSING'], [null, 'IPC_REQUEST_FAILED']] as const) {
    const f = fixture(async () => { throw error; }); f.rpc.push(encodeIpcFrame(request())); await f.rpc.drain();
    assert.deepEqual(decode(f.frames), [{ schemaVersion: 1, requestId: id(1), ok: false, error: code }]);
    assert.equal(f.reasons.length, 0);
  }
});

test('result schema rejects private extras, unknown notes and invalid receipts', async () => {
  const invalid = [null, { prepared: false }, { prepared: true, body: 'private' }, { ...connect, envelope: 'private' },
    { ...receipt, deliveryNote: 'private text' }, { ...receipt, body: 'private' },
    { ...receipt, receipt: { ...receipt.receipt, sender: 'private' } },
    { ...receipt, receipt: { ...receipt.receipt, sequence: 0 } },
    { ...receipt, receipt: { ...receipt.receipt, state: 'dispatched', transport: 'written' } }];
  for (const result of invalid) {
    const f = fixture(async () => result as Result); f.rpc.push(encodeIpcFrame(request())); await f.rpc.drain();
    assert.deepEqual(decode(f.frames), [{ schemaVersion: 1, requestId: id(1), ok: false, error: 'IPC_REQUEST_FAILED' }]);
  }
});

test('late oversized response cannot leak raw fields or escape full-wrapper framing', async () => {
  const f = fixture(async () => ({ ...connect, targetSessionId: 't'.repeat(MAX_FRAME_BYTES) }));
  f.rpc.push(encodeIpcFrame(request())); await f.rpc.drain();
  assert.deepEqual(decode(f.frames), [{ schemaVersion: 1, requestId: id(1), ok: false, error: 'IPC_FRAME_TOO_LARGE' }]);
});

test('normal EOF and explicit closure suppress pending handler results', async () => {
  for (const finish of ['end', 'close'] as const) {
    const entered = Promise.withResolvers<void>(); const gate = Promise.withResolvers<Result>();
    const f = fixture(async () => { entered.resolve(); return gate.promise; });
    f.rpc.push(encodeIpcFrame(request())); await entered.promise;
    f.rpc[finish](); assert.equal(await f.rpc.whenClosed, 'IPC_DECODER_CLOSED');
    gate.resolve(prepared); await f.rpc.drain(); assert.equal(f.frames.length, 0);
    f.rpc.close(); assert.deepEqual(f.reasons, ['IPC_DECODER_CLOSED']);
  }
});

test('malformed UTF-8, oversize and incomplete EOF permanently close framing', async () => {
  const badUtf8 = Buffer.from([0, 0, 0, 2, 0xc3, 0x28]);
  const oversized = Buffer.alloc(4); oversized.writeUInt32BE(MAX_FRAME_BYTES);
  for (const [bytes, code, eof] of [[badUtf8, 'IPC_FRAME_INVALID', false],
    [oversized, 'IPC_FRAME_TOO_LARGE', false], [Buffer.from([0, 0]), 'IPC_FRAME_EOF', true]] as const) {
    const f = fixture();
    if (eof) { f.rpc.push(bytes); assert.throws(() => f.rpc.end(), /^Error: IPC_FRAME_EOF$/); }
    else assert.throws(() => f.rpc.push(bytes), new RegExp(`^Error: ${code}$`));
    assert.equal(await f.rpc.whenClosed, code); assert.equal(f.calls.length, 0);
    assert.throws(() => f.rpc.push(encodeIpcFrame(request())), /^Error: IPC_DECODER_CLOSED$/);
  }
});

test('unexpected byte-reader exceptions never become raw close reasons', async () => {
  const bytes = encodeIpcFrame(request());
  Object.defineProperty(bytes, 'subarray', { value: () => { throw new Error('private reader body/path'); } });
  const f = fixture();
  assert.throws(() => f.rpc.push(bytes), /^Error: IPC_REQUEST_FAILED$/);
  assert.equal(await f.rpc.whenClosed, 'IPC_REQUEST_FAILED');
  assert.deepEqual(f.reasons, ['IPC_REQUEST_FAILED']); assert.equal(f.calls.length, 0);
});

test('write failure closes before queued writes and contains close callback failures', async () => {
  const reasons: string[] = []; let writes = 0;
  const rpc = createStdioRpc({ handle: async () => prepared,
    write: () => { writes += 1; throw new Error('private write failure'); },
    close: code => { reasons.push(code); throw new Error('private close failure'); } });
  rpc.push(Buffer.concat([encodeIpcFrame(request()), encodeIpcFrame(request(2))]));
  await rpc.drain(); assert.equal(await rpc.whenClosed, 'IPC_WRITE_FAILED');
  assert.equal(writes, 1); assert.deepEqual(reasons, ['IPC_WRITE_FAILED']);
});

test('closure between queued responses prevents the next complete write', async () => {
  const entered = Promise.withResolvers<void>(); const gate = Promise.withResolvers<void>(); let count = 0;
  const f = fixture(async () => prepared, async () => { if (++count === 1) { entered.resolve(); await gate.promise; } });
  f.rpc.push(Buffer.concat([encodeIpcFrame(request()), encodeIpcFrame(request(2))]));
  await entered.promise; f.rpc.close(); gate.resolve(); await f.rpc.drain();
  assert.equal(f.frames.length, 1);
});

test('a receipt cannot use a note that claims a different delivery state', async () => {
  const f = fixture(async () => ({ ...receipt, deliveryNote: CLAUDE_DELIVERY_NOTES.dispatched }));
  f.rpc.push(encodeIpcFrame(request())); await f.rpc.drain();
  assert.deepEqual(decode(f.frames), [{ schemaVersion: 1, requestId: id(1), ok: false, error: 'IPC_REQUEST_FAILED' }]);
});

test('a host fresh read can complete while the business handler waits for it', async () => {
  let rpc: ReturnType<typeof createStdioRpc>;
  const writes: Buffer[] = [];
  rpc = createStdioRpc({ handle: async () => {
    const current = await rpc.inspect(snapshot.pid);
    assert.deepEqual(current, snapshot); return prepared;
  }, write: frame => { writes.push(Buffer.from(frame)); }, close: () => {} });
  rpc.push(encodeIpcFrame(request()));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(writes.length, 1);
  const probe = decode(writes)[0];
  assert.equal(probe.operation, 'inspect'); assert.equal(probe.pid, snapshot.pid);
  rpc.push(encodeIpcFrame({ schemaVersion: 1, operation: 'inspect', requestId: probe.requestId,
    ok: true, snapshot }));
  await rpc.drain(); assert.equal(writes.length, 2);
  assert.deepEqual(decode(writes)[1], { schemaVersion: 1, requestId: id(1), ok: true, result: prepared });
});

test('control replies must match a live host-generated request and its requested PID', async () => {
  for (const mode of ['unknown-id', 'wrong-pid', 'extra-field'] as const) {
    const f = fixture(); const pending = f.rpc.inspect(snapshot.pid);
    await new Promise<void>(resolve => setImmediate(resolve));
    const probe = decode(f.frames)[0];
    const response = { schemaVersion: 1, operation: 'inspect', requestId: probe.requestId,
      ok: true, snapshot: mode === 'wrong-pid' ? { ...snapshot, pid: snapshot.pid + 1 } : snapshot,
      ...(mode === 'extra-field' ? { authority: 'user' } : {}) };
    if (mode === 'unknown-id') response.requestId = id(999);
    assert.throws(() => f.rpc.push(encodeIpcFrame(response)), /INVALID_IPC_CONTROL/);
    await assert.rejects(pending, /INVALID_IPC_CONTROL/);
  }
});

test('closed owned stdio rejects pending fresh reads and admits no new read', async () => {
  const f = fixture(); const pending = f.rpc.inspect(snapshot.pid);
  f.rpc.close(); await assert.rejects(pending, /IPC_DECODER_CLOSED/);
  await assert.rejects(f.rpc.inspect(snapshot.pid), /IPC_DECODER_CLOSED/);
});

test('fresh control reads do not accept cached or duplicate evidence', async () => {
  const f = fixture(); const first = f.rpc.inspect(snapshot.pid);
  await new Promise<void>(resolve => setImmediate(resolve));
  const probe = decode(f.frames)[0];
  const response = { schemaVersion: 1, operation: 'inspect', requestId: probe.requestId, ok: true, snapshot };
  f.rpc.push(encodeIpcFrame(response)); await first;
  const second = f.rpc.inspect(snapshot.pid);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.notEqual(decode(f.frames)[1].requestId, probe.requestId);
  assert.throws(() => f.rpc.push(encodeIpcFrame(response)), /INVALID_IPC_CONTROL/);
  await assert.rejects(second, /INVALID_IPC_CONTROL/);
});

test('control errors are fixed codes and invalid PID never writes', async () => {
  const f = fixture();
  for (const pid of [0, 1, -1, 1.5, 0x80000000]) {
    await assert.rejects(f.rpc.inspect(pid), /INVALID_IPC_CONTROL/);
  }
  assert.equal(f.frames.length, 0);
  const pending = f.rpc.inspect(snapshot.pid);
  await new Promise<void>(resolve => setImmediate(resolve));
  const probe = decode(f.frames)[0];
  f.rpc.push(encodeIpcFrame({ schemaVersion: 1, operation: 'inspect', requestId: probe.requestId,
    ok: false, error: 'PROCESS_IDENTITY_UNAVAILABLE' }));
  await assert.rejects(pending, /PROCESS_IDENTITY_UNAVAILABLE/);
  assert.deepEqual(f.reasons, []);
});

test('control errors cannot expose arbitrary helper messages', async () => {
  const f = fixture(); const pending = f.rpc.inspect(snapshot.pid);
  await new Promise<void>(resolve => setImmediate(resolve));
  const probe = decode(f.frames)[0];
  assert.throws(() => f.rpc.push(encodeIpcFrame({ schemaVersion: 1, operation: 'inspect',
    requestId: probe.requestId, ok: false, error: 'private/path body' })), /INVALID_IPC_CONTROL/);
  await assert.rejects(pending, /^Error: INVALID_IPC_CONTROL$/);
});

test('concurrent live reads correlate out-of-order results without sharing evidence', async () => {
  const f = fixture(); const first = f.rpc.inspect(snapshot.pid); const second = f.rpc.inspect(snapshot.parentPid);
  await new Promise<void>(resolve => setImmediate(resolve));
  const requests = decode(f.frames);
  const parent = { ...snapshot, pid: snapshot.parentPid, uniqueId: snapshot.parentUniqueId };
  for (const [probe, value] of [[requests[1], parent], [requests[0], snapshot]] as const) {
    f.rpc.push(encodeIpcFrame({ schemaVersion: 1, operation: 'inspect', requestId: probe.requestId, ok: true, snapshot: value }));
  }
  assert.deepEqual(await first, snapshot); assert.deepEqual(await second, parent);
});

test('a signed read is its own operation; replies must echo it and carry exactly one of sha256 or a signer', async () => {
  const signed = { ...snapshot, sha256: null, signing: { teamId: 'Q6L2SF6YDW', identifier: 'com.anthropic.claude-code', runtime: true } };
  const reply = async (operation: string, value: unknown, error?: string) => {
    const f = fixture(); const pending = f.rpc.inspectSigned(snapshot.pid);
    await new Promise<void>(resolve => setImmediate(resolve));
    const probe = decode(f.frames)[0];
    assert.deepEqual([probe.operation, probe.pid], ['inspect-signed', snapshot.pid]);
    const frame = encodeIpcFrame(error ? { schemaVersion: 1, operation, requestId: probe.requestId, ok: false, error }
      : { schemaVersion: 1, operation, requestId: probe.requestId, ok: true, snapshot: value });
    try { f.rpc.push(frame); } catch (thrown) { assert.match(String(thrown), /INVALID_IPC_CONTROL/); }
    return pending;
  };
  assert.deepEqual(await reply('inspect-signed', signed), signed);
  const hashed = { ...snapshot, signing: null };
  assert.deepEqual(await reply('inspect-signed', hashed), hashed);
  await assert.rejects(reply('inspect', signed), /INVALID_IPC_CONTROL/);
  for (const bad of [{ ...signed, sha256: 'a'.repeat(64) }, { ...snapshot, sha256: null, signing: null }, snapshot,
    { ...signed, signing: { ...signed.signing, teamId: 'q6l2sf6ydw' } }, { ...signed, signing: { ...signed.signing, runtime: 'yes' } },
    { ...signed, signing: { ...signed.signing, identifier: 'x" or anchor' } }]) {
    await assert.rejects(reply('inspect-signed', bad), /INVALID_IPC_CONTROL/);
  }
  await assert.rejects(reply('inspect-signed', null, 'CODE_SIGNING_UNAVAILABLE'), /^Error: CODE_SIGNING_UNAVAILABLE$/);
  const legacy = fixture(); const pending = legacy.rpc.inspect(snapshot.pid);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.throws(() => legacy.rpc.push(encodeIpcFrame({ schemaVersion: 1, operation: 'inspect-signed',
    requestId: decode(legacy.frames)[0].requestId, ok: true, snapshot: signed })), /INVALID_IPC_CONTROL/);
  await assert.rejects(pending, /INVALID_IPC_CONTROL/);
});

test('owned write failure rejects a pending live read without waiting for a reply', async () => {
  const f = fixture(async () => prepared, () => { throw new Error('private write failure'); });
  await assert.rejects(f.rpc.inspect(snapshot.pid), /^Error: IPC_WRITE_FAILED$/);
  assert.equal(await f.rpc.whenClosed, 'IPC_WRITE_FAILED');
});

const directory: SessionDirectoryResult = { sessions: [{ harness: 'dsh', sessionId: 'original-dsh',
  metadataRevision: 3, title: '产品文档整理与需求同步 😀', titleProvider: 'user',
  workspacePath: '/synthetic/workspace', cwd: '/synthetic/workspace/project', cwdSource: 'session-creation',
  worktreePath: '/synthetic/worktree', clientSurface: 'desktop' }], note: SESSION_DIRECTORY_NOTE };

test('empty and complete ten-field directories cross the original correlated RPC frame', async () => {
  const expected: SessionDirectoryResult[] = [{ sessions: [], note: SESSION_DIRECTORY_NOTE }, directory];
  let index = 0; const f = fixture(async () => expected[index++]!);
  f.rpc.push(Buffer.concat(expected.map((_, index) => encodeIpcFrame(request(index + 1)))));
  await f.rpc.drain();
  assert.deepEqual(decode(f.frames), expected.map((result, index) => ({
    schemaVersion: 1, requestId: id(index + 1), ok: true, result,
  })));
  assert.equal(f.reasons.length, 0);
});

test('directory RPC rejects wrong platforms and internal fields without publishing metadata', async () => {
  const row = directory.sessions[0]!;
  const invalid: unknown[] = [{ ...directory, note: 'user confirmed' }, { ...directory, ownerPid: 77 },
    { ...directory, sessions: [{ ...row, harness: 'claude-code' }] },
    { ...directory, sessions: [{ ...row, harness: 'codex' }] }];
  for (const field of ['endpoint', 'storageNamespace', 'hostInstanceId', 'routeGeneration', 'authority',
    'configRoot', 'projectDir', 'pid', 'socket']) {
    invalid.push({ ...directory, sessions: [{ ...row, [field]: 'private-internal' }] });
  }
  let reads = 0;
  invalid.push({ ...directory, sessions: [Object.defineProperty({ ...row }, 'title', {
    enumerable: true, get() { reads++; return 'private-title'; },
  })] });
  for (const result of invalid) {
    const f = fixture(async () => result as Result);
    f.rpc.push(encodeIpcFrame(request())); await f.rpc.drain();
    assert.deepEqual(decode(f.frames), [{ schemaVersion: 1, requestId: id(1), ok: false, error: 'IPC_REQUEST_FAILED' }]);
  }
  assert.equal(reads, 0);
});

test('directory RPC preserves only the three fixed metadata error codes', async () => {
  for (const [message, error] of [['METADATA_QUERY_UNAVAILABLE', 'METADATA_QUERY_UNAVAILABLE'],
    ['METADATA_QUERY_FAILED', 'METADATA_QUERY_FAILED'], ['METADATA_CONTEXT_TOO_LARGE', 'METADATA_CONTEXT_TOO_LARGE'], ['METADATA_QUERY_PRIVATE_PATH', 'IPC_REQUEST_FAILED']]) {
    const f = fixture(async () => { throw new Error(message); });
    f.rpc.push(encodeIpcFrame(request())); await f.rpc.drain();
    assert.deepEqual(decode(f.frames), [{ schemaVersion: 1, requestId: id(1), ok: false, error }]);
  }
});

test('directory results that fit alone still reject an oversized complete RPC wrapper', async () => {
  const base = { ...directory, sessions: [{ ...directory.sessions[0]!, title: '' }] };
  const title = 'x'.repeat(MAX_FRAME_BYTES - encodeIpcFrame(base).length);
  const result = { ...base, sessions: [{ ...base.sessions[0]!, title }] };
  assert.equal(encodeIpcFrame(result).length, MAX_FRAME_BYTES);
  const f = fixture(async () => result); f.rpc.push(encodeIpcFrame(request())); await f.rpc.drain();
  assert.deepEqual(decode(f.frames), [{ schemaVersion: 1, requestId: id(1), ok: false, error: 'IPC_FRAME_TOO_LARGE' }]);
  assert.equal(result.sessions[0]!.title, title);
});

test('quiesce is one exact owned control, not pipe drain; inspect remains live until drained', async () => {
  const f = fixture(); const drained = f.rpc.quiesce();
  let settled = false; void drained.then(() => { settled = true; });
  await Promise.resolve(); await Promise.resolve();
  const control = decode(f.frames)[0];
  assert.deepEqual(Object.keys(control).sort(), ['schemaVersion', 'operation', 'requestId'].sort());
  assert.equal(control.operation, 'quiesce'); assert.equal(settled, false);
  await assert.rejects(f.rpc.quiesce(), /INVALID_IPC_CONTROL/);
  const inspected = f.rpc.inspect(snapshot.pid); await Promise.resolve(); await Promise.resolve();
  const inspect = decode(f.frames)[1];
  f.rpc.push(encodeIpcFrame({ schemaVersion: 1, operation: 'inspect', requestId: inspect.requestId, ok: true, snapshot }));
  assert.deepEqual(await inspected, snapshot);
  f.rpc.push(encodeIpcFrame({ ...control, ok: true, result: { drained: true } }));
  assert.deepEqual(await drained, { drained: true });
  await assert.rejects(f.rpc.inspect(snapshot.pid), /INVALID_IPC_CONTROL/); f.rpc.close();
});

test('reply-written notification follows successful actual write and can enqueue quiesce without awaiting itself', async () => {
  const gate = Promise.withResolvers<void>(); const entered = Promise.withResolvers<void>();
  const frames: Buffer[] = []; const replies: unknown[] = []; let quiesced: Promise<unknown> | undefined;
  const rpc = createStdioRpc({ handle: async () => prepared, close: () => {},
    write: async frame => { frames.push(frame); if (frames.length === 1) { entered.resolve(); await gate.promise; } },
    onReplyWritten: reply => { replies.push(reply); quiesced = rpc.quiesce(); } });
  rpc.push(encodeIpcFrame(request())); await entered.promise; assert.deepEqual(replies, []);
  gate.resolve(); await rpc.drain();
  assert.deepEqual(replies, [{ requestId: id(1), ok: true }]);
  const control = decode(frames)[1]; assert.equal(control.operation, 'quiesce');
  rpc.push(encodeIpcFrame({ ...control, ok: true, result: { drained: true } })); await quiesced;
  rpc.close();
});

for (const change of [{ requestId: id(99) }, { operation: 'inspect' }, { result: { drained: false } },
  { extra: true }, { ok: false, error: 'UNKNOWN_FAILURE' }]) {
  test('malformed quiesce control never resolves or aliases inspect: ' + JSON.stringify(change), async () => {
    const f = fixture(); const pending = f.rpc.quiesce(); const rejected = assert.rejects(pending);
    await Promise.resolve(); await Promise.resolve(); const control = decode(f.frames)[0];
    const reply = { ...control, ok: true, result: { drained: true }, ...change };
    assert.throws(() => f.rpc.push(encodeIpcFrame(reply)), /INVALID_IPC_CONTROL/); await rejected;
  });
}

test('quiesce failure and immediate close settle without late revival', async () => {
  const f = fixture(); const pending = f.rpc.quiesce(); const rejected = assert.rejects(pending, /IPC_REQUEST_FAILED/);
  await Promise.resolve(); await Promise.resolve(); const control = decode(f.frames)[0];
  f.rpc.push(encodeIpcFrame({ ...control, ok: false, error: 'IPC_REQUEST_FAILED' })); await rejected;
  await assert.rejects(f.rpc.quiesce(), /INVALID_IPC_CONTROL/);
  const other = fixture(); const waiting = other.rpc.quiesce(); const interrupted = assert.rejects(waiting, /IPC_DECODER_CLOSED/);
  other.rpc.close(); await interrupted; await assert.rejects(other.rpc.quiesce(), /IPC_DECODER_CLOSED/);
});

for (const result of [{ prepared: false }, { linkId: 'x'.repeat(MAX_FRAME_BYTES), targetSessionId: 'target' }]) {
  test('reply-written reports the actual sanitized error frame after invalid or oversized output', async () => {
    const frames: Buffer[] = []; const replies: unknown[] = [];
    const rpc = createStdioRpc({ handle: async () => result as unknown as Result, close: () => {},
      write: frame => { frames.push(frame); }, onReplyWritten: reply => { replies.push(reply); } });
    rpc.push(encodeIpcFrame(request())); await rpc.drain();
    assert.equal(decode(frames)[0].ok, false); assert.deepEqual(replies, [{ requestId: id(1), ok: false }]); rpc.close();
  });
}

for (const mode of ['failed', 'closed']) {
  test('reply-written is suppressed after ' + mode + ' pipe write', async () => {
    const gate = Promise.withResolvers<void>(); const entered = Promise.withResolvers<void>(); const replies: unknown[] = [];
    const rpc = createStdioRpc({ handle: async () => prepared, close: () => {},
      write: async () => { entered.resolve(); await gate.promise; if (mode === 'failed') throw Error('PRIVATE'); },
      onReplyWritten: reply => { replies.push(reply); } });
    rpc.push(encodeIpcFrame(request())); await entered.promise;
    if (mode === 'closed') rpc.close(); gate.resolve(); await rpc.drain();
    assert.deepEqual(replies, []); assert.equal(await rpc.whenClosed, mode === 'closed' ? 'IPC_DECODER_CLOSED' : 'IPC_WRITE_FAILED');
  });
}

test('a duplicate or late drained frame cannot revive completed or closed quiesce', async () => {
  const f = fixture(); const pending = f.rpc.quiesce(); await Promise.resolve(); await Promise.resolve();
  const reply = { ...decode(f.frames)[0], ok: true, result: { drained: true } };
  f.rpc.push(encodeIpcFrame(reply)); await pending;
  assert.throws(() => f.rpc.push(encodeIpcFrame(reply)), /INVALID_IPC_CONTROL/);
  assert.equal(await f.rpc.whenClosed, 'INVALID_IPC_CONTROL');
  assert.throws(() => f.rpc.push(encodeIpcFrame(reply)), /IPC_DECODER_CLOSED/);
});

test('daily hookOutput results pass only the allowlisted shapes: context for PostToolUse and UserPromptSubmit, ask or deny for PreToolUse', async () => {
  const allowed = [{ hookOutput: {} }, { hookOutput: { decision: 'block', reason: '已登记' } },
    { hookOutput: { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: '{"ok":true}' } } },
    { hookOutput: { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'Switchboard 回复档位：direct' } } },
    { hookOutput: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: '审批' } } },
    { hookOutput: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: '拒绝' } } }];
  let index = 0;
  const f = fixture(async () => allowed[index++] as never);
  f.rpc.push(Buffer.concat(allowed.map((_, i) => encodeIpcFrame(request(i + 1))))); await f.rpc.drain();
  assert.deepEqual(decode(f.frames), allowed.map((result, i) => ({ schemaVersion: 1, requestId: id(i + 1), ok: true, result })));
  const rejected = [{ hookOutput: { decision: 'approve', reason: 'x' } }, { hookOutput: { decision: 'block', reason: ' ' } },
    { hookOutput: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } } },
    { hookOutput: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'x' } } },
    { hookOutput: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: ' ' } } },
    { hookOutput: { hookSpecificOutput: { hookEventName: 'PostToolUse', permissionDecision: 'deny', permissionDecisionReason: 'x' } } },
    { hookOutput: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'x', updatedInput: {} } } },
    { hookOutput: { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'x', extra: 1 } } },
    { hookOutput: { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ' ' } } },
    { hookOutput: { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'x' } } },
    { hookOutput: { continue: false } }, { hookOutput: [] }, { hookOutput: {}, extra: true }];
  index = 0;
  const g = fixture(async () => rejected[index++] as never);
  g.rpc.push(Buffer.concat(rejected.map((_, i) => encodeIpcFrame(request(i + 1))))); await g.rpc.drain();
  assert.deepEqual(decode(g.frames).map(frame => frame.error), rejected.map(() => 'IPC_REQUEST_FAILED'));
});
