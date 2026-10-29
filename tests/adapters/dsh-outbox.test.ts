// INPUT: Synthetic fixed desktop agents, private registered targets and test sockets.
// OUTPUT: Source envelope/native body checks; Outbox routing, deduplication, source authority and target-change regressions.
// POS: Offline assembled dispatch evidence, not actual Harness model reception.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createDshOutbox } from '../../src/adapters/dsh/outbox.ts';
import { registerClaude } from '../../src/adapters/claude/registration.ts';

const sid = '00000000-0000-0000-0000-000000000001';
const owner = { pid: 77, parent: 1, command: '/fixture/2.1.295', start: 'synthetic-start' };
const agent = { id: 'session-A', session: { header: { id: 'session-A' } } };
const other = { id: 'session-B', session: { header: { id: 'session-B' } } };

async function fixture() {
  const root = await mkdtemp('/tmp/ms-outbox-');
  const socket = root + '/native.sock';
  const packets: Record<string, unknown>[] = [];
  const server = net.createServer(connection => {
    let packet = ''; connection.setEncoding('utf8');
    connection.on('data', chunk => { packet += chunk; });
    connection.on('end', () => { packets.push(JSON.parse(packet)); connection.end(); });
  });
  server.listen(socket); await once(server, 'listening');
  let alive = true; let archived = false;
  const inspect = () => alive ? owner : null;
  const route = await registerClaude(root, { session_id: sid }, socket, 77, inspect);
  const host = { surface: 'desktop', version: '0.2.0-rc.2', storageNamespace: 'a'.repeat(64),
    hostInstanceId: 'synthetic-host', routeGeneration: 'generation-1',
    getAgent: (id: string) => [agent, other].find(item => item.id === id), isArchived: () => archived };
  const outbox = createDshOutbox(host, root, inspect);
  return { root, socket, route, inspect, packets, outbox,
    archive: () => { archived = true; }, stopOwner: () => { alive = false; },
    close: async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true }); } };
}

test('exact target connection is reused and replay writes only once with original body', async () => {
  const f = await fixture();
  try {
    const execution = { agent, arguments: { sender: 'victim' } };
    const linkId = await f.outbox.connect(execution, sid);
    assert.equal(await f.outbox.connect(execution, sid), linkId);
    const request = { schemaVersion: 1, messageId: 'message-A', linkId, body: '原文 👋' };
    const first = await f.outbox.send(execution, request);
    f.stopOwner();
    assert.deepEqual(await f.outbox.send(execution, request), first);
    assert.equal(first.state, 'delivery-unknown'); assert.equal(first.transport, 'written');
    assert.equal(f.packets.length, 1);
    const content = (f.packets[0].message as { content: string }).content;
    assert.equal(content.split('\n')[0], '来源：DSH | Agent Message Switchboard');
    assert.equal(JSON.parse(content.split('\n')[1]).sender.nativeSessionId, agent.id);
    assert.equal(content.slice(content.indexOf('以下为原样正文：\n') + '以下为原样正文：\n'.length), request.body);
    assert.equal(first.envelope.sender.nativeSessionId, agent.id);
    assert.equal(first.envelope.recipient.nativeSessionId, sid);
    assert.equal(first.envelope.source, 'peer');
    assert.equal(first.envelope.authority, 'none');
  } finally { await f.close(); }
});

test('forged execution, archived source and another root using the link are denied', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.outbox.connect({ agent: { ...agent } }, sid), /INVALID_DSH_SOURCE/);
    await assert.rejects(f.outbox.connect({ agent }, 'local_desktop-id'), /INVALID_SESSION/);
    const linkId = await f.outbox.connect({ agent }, sid);
    const request = { schemaVersion: 1, messageId: 'message-A', linkId, body: 'body' };
    await assert.rejects(f.outbox.send({ agent: other }, request), /NOT_A_MEMBER/);
    f.archive();
    await assert.rejects(f.outbox.send({ agent }, request), /INVALID_DSH_SOURCE/);
    assert.equal(f.packets.length, 0);
  } finally { await f.close(); }
});

for (const change of ['offline', 'ambiguous', 'generation']) {
  test(`target becoming ${change} after connect never receives a new write`, async () => {
    const f = await fixture();
    try {
      const linkId = await f.outbox.connect({ agent }, sid);
      if (change === 'offline') f.stopOwner();
      if (change === 'ambiguous') await registerClaude(f.root,
        { session_id: '00000000-0000-0000-0000-000000000002' }, f.socket, 77, f.inspect);
      if (change === 'generation') await writeFile(f.root + '/' + sid + '.json', JSON.stringify({ ...f.route,
        endpoint: { ...f.route.endpoint, routeGeneration: 'replaced-generation' } }));
      const receipt = await f.outbox.send({ agent }, { schemaVersion: 1, messageId: 'message-A', linkId, body: 'body' });
      assert.equal(receipt.state, 'delivery-unknown'); assert.equal(receipt.transport, null);
      assert.equal(f.packets.length, 0);
      await assert.rejects(f.outbox.connect({ agent }, sid),
        change === 'generation' ? /TARGET_CHANGED/ : /TARGET_UNAVAILABLE/);
    } finally { await f.close(); }
  });
}
