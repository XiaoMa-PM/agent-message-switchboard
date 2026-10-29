// INPUT: Scripted fake msd sockets and malformed reply frames.
// OUTPUT: Exact request envelope, result passthrough and fixed client error-code regressions.
// POS: Offline control-client tests; no real msd, launchd or user root.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { callControl } from '../../src/cli/control-client.ts';
import { startFakeDaemon, okReply, errorReply, type FakeReply } from './fake-daemon.ts';

const ID = '7d2c3c1e-6c55-4b2e-9a43-4f3a5f9b1c20';
const options = { timeoutMs: 2000, newId: () => ID };

async function withDaemon(reply: FakeReply, run: (socketPath: string, requests: unknown[]) => Promise<void>): Promise<void> {
  const daemon = await startFakeDaemon(reply);
  try { await run(daemon.socketPath, daemon.requests); } finally { await daemon.close(); }
}

test('one request frame carries schemaVersion, UUID id, method and params; result is returned verbatim', async () => {
  const result = { version: '0.1.0', links: 2 };
  await withDaemon(okReply(result), async (socketPath, requests) => {
    assert.deepEqual(await callControl(socketPath, 'messages.list', { linkId: 'L1', limit: 5 }, options), result);
    assert.deepEqual(requests, [{ schemaVersion: 1, id: ID, method: 'messages.list', params: { linkId: 'L1', limit: 5 } }]);
  });
});

test('default id generator produces a fresh random UUID per call', async () => {
  await withDaemon(okReply(null), async (socketPath, requests) => {
    await callControl(socketPath, 'status', {}, { timeoutMs: 2000 });
    await callControl(socketPath, 'status', {}, { timeoutMs: 2000 });
    const ids = requests.map(request => (request as { id: string }).id);
    for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(ids[0], ids[1]);
  });
});

test('daemon refusal surfaces DAEMON_ERROR with the fixed daemon code as detail', async () => {
  await withDaemon(errorReply('LINK_NOT_FOUND'), async socketPath => {
    await assert.rejects(callControl(socketPath, 'links.list', {}, options),
      (error: { code?: string; detail?: string }) => error.code === 'DAEMON_ERROR' && error.detail === 'LINK_NOT_FOUND');
  });
});

test('absent socket is DAEMON_UNAVAILABLE and a silent daemon is DAEMON_TIMEOUT', async () => {
  await assert.rejects(callControl('/tmp/ms-cli-absent/msd.sock', 'status', {}, options), { code: 'DAEMON_UNAVAILABLE' });
  await withDaemon('hang', async socketPath => {
    await assert.rejects(callControl(socketPath, 'status', {}, { timeoutMs: 50, newId: () => ID }), { code: 'DAEMON_TIMEOUT' });
  });
});

test('malformed or mismatched replies fail closed as DAEMON_PROTOCOL_INVALID', async () => {
  const replies: FakeReply[] = [
    'close',
    Buffer.from([0, 0, 0, 3, 0x7b, 0x7d, 0x7d]),
    Buffer.from([0, 0, 0, 9, 0x7b]),
    () => ({ schemaVersion: 1, id: 'other', ok: true, result: 1 }),
    request => ({ schemaVersion: 2, id: request.id, ok: true, result: 1 }),
    request => ({ schemaVersion: 1, id: request.id, ok: true }),
    request => ({ schemaVersion: 1, id: request.id, ok: true, result: 1, extra: true }),
    request => ({ schemaVersion: 1, id: request.id, ok: false, error: 'lower case' }),
    request => ({ schemaVersion: 1, id: request.id, ok: false, error: 'CODE', result: 1 }),
    request => ({ schemaVersion: 1, id: request.id, ok: 'yes', result: 1 }),
    () => [1, 2],
    () => null,
  ];
  for (const reply of replies) {
    await withDaemon(reply, async socketPath => {
      await assert.rejects(callControl(socketPath, 'status', {}, options), { code: 'DAEMON_PROTOCOL_INVALID' }, String(reply));
    });
  }
});
