// INPUT: Canonical platform temporary directories and private filesystem pins, owned fake child streams and kernel-shaped control responses.
// OUTPUT: Owned stdio bootstrap identity matching, closure and malformed-stream regressions.
// POS: Offline launcher integration; fake snapshots do not prove real kernel authentication.
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { startBroker } from '../../src/bridge/owned-broker.ts';
import { createIpcDecoder, encodeIpcFrame } from '../../src/bridge/ipc-frame.ts';
import { type ChildProcessWithoutNullStreams } from 'node:child_process';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

async function fixture(t: { after: (fn: () => unknown) => void }, bad = '') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ms-owned-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const codeRoot = join(root, 'code'); await mkdir(codeRoot, { mode: 0o700 });
  const pythonPath = join(root, 'python'); const entryPath = join(codeRoot, 'entry.py'); const configPath = join(codeRoot, 'broker-config.json');
  await writeFile(pythonPath, 'python fixture', { mode: 0o700 }); await writeFile(entryPath, 'entry fixture', { mode: 0o600 });
  await writeFile(configPath, '{}', { mode: 0o600 });
  const config = { python: { path: pythonPath, sha256: hash('python fixture') }, codeRoot, entryPath, configPath,
    codePins: [{ path: entryPath, sha256: hash('entry fixture') }] };
  const child = new EventEmitter() as EventEmitter & Record<string, any>;
  child.pid = 800; child.exitCode = null; child.signalCode = null;
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); let killed = 0;
  child.kill = () => { killed++; child.signalCode = 'SIGTERM'; child.stdout.end(); queueMicrotask(() => child.emit('exit', null, 'SIGTERM')); return true; };
  const parent = { pid: process.pid, uid: process.getuid!(), pidVersion: 11, uniqueId: '100',
    parentPid: 1, parentUniqueId: '1', exe: await realpath(process.execPath), sha256: 'b'.repeat(64) };
  const own = { ...parent, pid: child.pid, parentPid: process.pid, parentUniqueId: parent.uniqueId,
    uniqueId: '200', pidVersion: 12, exe: pythonPath, sha256: config.python.sha256 };
  const decoder = createIpcDecoder(); const controls: any[] = [];
  child.stdin = new Writable({ write(bytes, _encoding, done) {
    for (const value of decoder.push(bytes) as any[]) {
      controls.push(value);
      if (value.operation === 'inspect') {
        const row = value.pid === process.pid ? parent : own;
        const snapshot = bad === 'parent' && row === own ? { ...row, parentUniqueId: '999' }
          : bad === 'pin' && row === own ? { ...row, sha256: 'c'.repeat(64) } : row;
        queueMicrotask(() => child.stdout.write(encodeIpcFrame({ schemaVersion: 1, operation: 'inspect', requestId: value.requestId, ok: true, snapshot })));
      }
    }
    done();
  } });
  return { config, child: child as unknown as ChildProcessWithoutNullStreams, killed: () => killed, own, parent, controls };
}

test('owned child is returned only after fresh stable kernel/path/parent checks', async t => {
  const f = await fixture(t);
  const broker = await startBroker(f.config, async () => ({ prepared: true }), () => f.child);
  assert.deepEqual(broker.childIdentity, f.own); assert.deepEqual(broker.parentIdentity, f.parent);
  assert.deepEqual(await broker.inspect(f.child.pid!), f.own);
  await broker.close(); await broker.close(); assert.equal(f.killed(), 1);
  await assert.rejects(broker.inspect(f.child.pid!), /IPC_DECODER_CLOSED/);
});

for (const bad of ['parent', 'pin']) {
  test(`wrong ${bad} closes the owned child and returns no usable broker`, async t => {
    const f = await fixture(t, bad);
    await assert.rejects(startBroker(f.config, async () => ({ prepared: true }), () => f.child), /HELPER_START_FAILED/);
    assert.equal(f.killed(), 1);
  });
}

test('malformed owned stdout closes pending reads and terminates the owned child', async t => {
  const f = await fixture(t); const broker = await startBroker(f.config, async () => ({ prepared: true }), () => f.child);
  f.child.stdout.emit('data', Buffer.from([0,0,0,0]));
  await broker.close(); assert.equal(f.killed(), 1);
});

test('owned quiesce waits for native drained while immediate close can interrupt it', async t => {
  const f = await fixture(t); const broker = await startBroker(f.config, async () => ({ prepared: true }), () => f.child);
  const pending = broker.quiesce(); const rejected = assert.rejects(pending, /IPC_DECODER_CLOSED/);
  await assert.rejects(broker.quiesce(), /INVALID_IPC_CONTROL/);
  await broker.close(); await rejected; assert.equal(f.killed(), 1);
});

test('owned quiesce success is correlated and blocks later inspection without killing until close', async t => {
  const f = await fixture(t); const broker = await startBroker(f.config, async () => ({ prepared: true }), () => f.child);
  const pending = broker.quiesce(); await Promise.resolve(); await Promise.resolve();
  const control = f.controls.find(value => value.operation === 'quiesce'); assert.ok(control);
  assert.deepEqual(await broker.inspect(f.child.pid!), f.own);
  f.child.stdout.emit('data', encodeIpcFrame({ ...control, ok: true, result: { drained: true } }));
  assert.deepEqual(await pending, { drained: true }); assert.equal(f.killed(), 0);
  await assert.rejects(broker.inspect(f.child.pid!), /INVALID_IPC_CONTROL/); await broker.close();
});

for (const event of ['exit', 'error']) {
  test('owned child ' + event + ' rejects pending quiesce without hanging', async t => {
    const f = await fixture(t); const broker = await startBroker(f.config, async () => ({ prepared: true }), () => f.child);
    const pending = broker.quiesce(); const rejected = assert.rejects(pending, /IPC_DECODER_CLOSED/);
    f.child.emit(event); await rejected; await broker.close();
  });
}

test('owned successful reply-write callback is trusted and excludes control frames', async t => {
  const f = await fixture(t); const replies: unknown[] = []; const written = Promise.withResolvers<void>();
  const broker = await startBroker(f.config, async () => ({ prepared: true }), () => f.child, reply => { replies.push(reply); written.resolve(); });
  assert.deepEqual(replies, []);
  const requestId = '11111111-1111-4111-8111-111111111111';
  f.child.stdout.emit('data', encodeIpcFrame({ schemaVersion: 1, requestId,
    peer: { pid: f.own.pid, uid: f.own.uid, pidVersion: f.own.pidVersion }, snapshots: [[f.own], [f.own]], payload: {} }));
  await written.promise;
  assert.deepEqual(replies, [{ requestId, ok: true }]); await broker.close();
});

for (const event of ['exit', 'error']) {
  test('owned child ' + event + ' publishes closure while business handler has not replied', async t => {
    const f = await fixture(t); const entered = Promise.withResolvers<void>(); const gate = Promise.withResolvers<void>();
    const replies: unknown[] = [];
    const broker = await startBroker(f.config, async () => { entered.resolve(); await gate.promise; return { prepared: true }; },
      () => f.child, reply => { replies.push(reply); });
    f.child.stdout.emit('data', encodeIpcFrame({ schemaVersion: 1,
      requestId: '11111111-1111-4111-8111-111111111112',
      peer: { pid: f.own.pid, uid: f.own.uid, pidVersion: f.own.pidVersion },
      snapshots: [[f.own], [f.own]], payload: {} }));
    await entered.promise; f.child.emit(event);
    assert.ok(broker.whenClosed instanceof Promise);
    assert.equal(await broker.whenClosed, 'IPC_DECODER_CLOSED');
    assert.deepEqual(replies, []); await assert.rejects(broker.quiesce(), /IPC_DECODER_CLOSED/);
    gate.resolve(); await broker.close(); assert.deepEqual(replies, []);
  });
}
