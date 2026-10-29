// INPUT: Synthetic profiles, private temporary directories and a directory alias.
// OUTPUT: Source envelope/native body checks; Stable opaque profile namespace and invalid metadata regressions.
// POS: Offline DSH identity canonicalization tests, not a real Host profile proof.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, symlink, rm, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import net from 'node:net';
import { once } from 'node:events';
import { createDshSourceBinding } from '../../src/adapters/dsh/source.ts';
import { createNativeInboxPush } from '../../src/adapters/claude/inbox.ts';
import { Router } from '../../src/router/router.ts';
import { createDshStorageNamespace } from '../../src/adapters/dsh/namespace.ts';

test('canonical profile hash is stable across aliases and separates names and directories', async () => {
  const root = await mkdtemp('/tmp/ms-namespace-');
  try {
    await mkdir(root + '/data');
    await mkdir(root + '/other');
    await symlink(root + '/data', root + '/alias');
    const hash = await createDshStorageNamespace({ name: 'desktop', dir: root + '/data' });
    const expected = createHash('sha256').update(JSON.stringify([await realpath(root + '/data'), 'desktop'])).digest('hex');
    assert.equal(hash, expected);
    assert.match(hash, /^[a-f0-9]{64}$/);
    assert.equal(hash.includes(root), false);
    assert.equal(await createDshStorageNamespace({ name: 'desktop', dir: root + '/alias' }), hash);
    assert.notEqual(await createDshStorageNamespace({ name: 'other', dir: root + '/data' }), hash);
    assert.notEqual(await createDshStorageNamespace({ name: 'desktop', dir: root + '/other' }), hash);
  } finally { await rm(root, { recursive: true }); }
});

test('missing, blank name or non-absolute directory cannot generate a namespace', async () => {
  for (const profile of [null, {}, { name: '', dir: '/fixture' }, { name: ' ', dir: '/fixture' },
    { name: 'desktop', dir: 'relative/profile' }, { name: 'desktop', dir: 1 }]) {
    await assert.rejects(createDshStorageNamespace(profile), /INVALID_DSH_PROFILE/);
  }
});


test('missing profile directory reports a fixed error without its plaintext path', async () => {
  const root = await mkdtemp('/tmp/ms-namespace-');
  await rm(root, { recursive: true });
  await assert.rejects(createDshStorageNamespace({ name: 'desktop', dir: root }),
    (error: unknown) => error instanceof Error && error.message === 'INVALID_DSH_PROFILE');
});


test('profile hash reaches native Inbox sender while the plaintext profile stays private', async () => {
  const root = await mkdtemp('/tmp/ms-namespace-');
  const socket = root + '/native.sock';
  const received = Promise.withResolvers<Record<string, unknown>>();
  const server = net.createServer(connection => {
    let packet = '';
    connection.setEncoding('utf8');
    connection.on('data', chunk => { packet += chunk; });
    connection.on('end', () => { received.resolve(JSON.parse(packet)); connection.end(); });
  });
  try {
    server.listen(socket); await once(server, 'listening');
    const storageNamespace = await createDshStorageNamespace({ name: 'desktop', dir: root });
    const agent = { id: 'session-A', session: { header: { id: 'session-A' } } };
    const bind = createDshSourceBinding({ surface: 'desktop', version: '0.2.0-rc.2', storageNamespace,
      hostInstanceId: 'synthetic-host', routeGeneration: 'generation-1',
      getAgent: () => agent, isArchived: () => false });
    const source = bind({ agent, arguments: { sender: '/fixture/forged-profile' } });
    const target = { schemaVersion: 1, endpointId: 'claude-fixture', harness: 'claude-code',
      storageNamespace: 'synthetic-claude', nativeSessionId: 'synthetic-id',
      hostInstanceId: 'synthetic-target', routeGeneration: 'target-generation' } as const;
    const router = new Router();
    const sender = router.register(source, () => ({ state: 'delivery-unknown', transport: null }));
    router.register(target, createNativeInboxPush(target, socket));
    const receipt = await sender.send({ schemaVersion: 1, messageId: 'synthetic-message',
      linkId: sender.connect(target.endpointId), body: 'original body' });
    const packet = await received.promise;
    assert.equal(packet.from, 'dsh-session:' + source.endpointId);
    assert.ok(String(packet.from).includes(storageNamespace));
    assert.equal(String(packet.from).includes(root), false);
    assert.equal(String(packet.from).includes('desktop'), false);
    assert.equal(String(packet.from).includes('forged-profile'), false);
    assert.equal((packet.message as { content: string }).content.endsWith('以下为原样正文：\noriginal body'), true);
    assert.equal(receipt.state, 'delivery-unknown');
    assert.equal(receipt.transport, 'written');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true }); }
});
