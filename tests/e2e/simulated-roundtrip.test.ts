// INPUT: Router-connected fake sessions and synthetic send/reply requests.
// OUTPUT: Push/replay/order evidence, acknowledge-before-reply enforcement, and pending-push limits and explicit transport evidence.
// POS: In-process JSON simulation; does not prove any real Harness integration.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Router } from '../../src/router/router.ts';
import { endpoint, session } from '../helpers/session.ts';

const request = (linkId: string, messageId: string, body = '你好 👋\n 原样正文 ') =>
  ({ schemaVersion: 1, linkId, messageId, body });

test('three rounds of pushed A→B→A preserve body and original reply address', async () => {
  const router = new Router();
  const a = session(router, endpoint('a'));
  const b = session(router, endpoint('b', 'claude-code'));
  const link = a.connection.connect('b');
  assert.equal(b.connection.connect('a'), link);
  for (let i = 0; i < 3; i++) {
    const receipt = await a.connection.send(request(link, `m${i}`));
    assert.equal(receipt.state, 'dispatched');
    const incoming = b.observed()[i];
    assert.equal(incoming.body, '你好 👋\n 原样正文 ');
    assert.equal(incoming.replyTo.endpointId, 'a');
    await b.connection.reply({ schemaVersion: 1, messageId: `r${i}`, inReplyTo: incoming.messageId, body: `答复${i}` });
    assert.equal(a.observed()[i].inReplyTo, incoming.messageId);
  }
  assert.deepEqual(b.observed().map(x => x.sequence), [1, 2, 3]);
  assert.deepEqual(a.observed().map(x => x.sequence), [1, 2, 3]);
});

test('every same-Harness pair requires native tools', () => {
  for (const harness of ['dsh', 'claude-code', 'codex'] as const) {
    const router = new Router();
    const a = session(router, endpoint('a', harness));
    session(router, { ...endpoint('b', harness), storageNamespace: 'different-workspace' });
    assert.throws(() => a.connection.connect('b'), /USE_NATIVE_TOOLS/);
  }
});

test('third session cannot send on a link or reply to another recipient', async () => {
  const router = new Router();
  const a = session(router, endpoint('a'));
  const b = session(router, endpoint('b', 'codex'));
  const c = session(router, endpoint('c', 'claude-code'));
  const link = a.connection.connect('b');
  await a.connection.send(request(link, 'm'));
  await assert.rejects(c.connection.send(request(link, 'c')), /NOT_A_MEMBER/);
  await assert.rejects(c.connection.reply({ schemaVersion: 1, messageId: 'r', inReplyTo: 'm', body: 'forged' }), /NOT_RECIPIENT/);
  await assert.rejects(b.connection.reply({ schemaVersion: 1, messageId: 'r', inReplyTo: 'm', body: 'x', replyTo: 'c' }), /INVALID_/);
  assert.equal(c.observed().length, 0);
});

test('replay returns the original result, conflicting IDs fail without redelivery', async () => {
  const router = new Router();
  const a = session(router, endpoint('a'));
  const b = session(router, endpoint('b', 'codex'));
  const link = a.connection.connect('b');
  const first = a.connection.send(request(link, 'same'));
  const replay = a.connection.send(request(link, 'same'));
  assert.deepEqual(await replay, await first);
  assert.equal(b.observed().length, 1);
  await assert.rejects(a.connection.send(request(link, 'same', 'different')), /MESSAGE_ID_CONFLICT/);
  await assert.rejects(b.connection.send(request(link, 'same')), /MESSAGE_ID_CONFLICT/);
  const c = session(router, endpoint('c', 'claude-code'));
  await assert.rejects(a.connection.send(request(a.connection.connect('c'), 'same')), /MESSAGE_ID_CONFLICT/);
  assert.equal(c.observed().length, 0);
});

test('an asynchronous push cannot be overtaken in the same direction', async () => {
  const gate = Promise.withResolvers<void>();
  const router = new Router();
  const a = session(router, endpoint('a'));
  const b = session(router, endpoint('b', 'codex'), frame => frame.messageId === 'first' ? gate.promise : undefined);
  const link = a.connection.connect('b');
  const first = a.connection.send(request(link, 'first'));
  const second = a.connection.send(request(link, 'second'));
  await Promise.resolve();
  assert.deepEqual(b.observed().map(x => x.messageId), ['first']);
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(b.observed().map(x => x.messageId), ['first', 'second']);
});

test('a failed push is delivery-unknown and replay does not retry it', async () => {
  const router = new Router();
  const a = session(router, endpoint('a'));
  const b = session(router, endpoint('b', 'codex'), () => { throw new Error('synthetic failure'); });
  const link = a.connection.connect('b');
  const result = await a.connection.send(request(link, 'm'));
  assert.equal(result.state, 'delivery-unknown');
  assert.deepEqual(await a.connection.send(request(link, 'm')), result);
  assert.equal(b.observed().length, 1);
});

for (const mode of ['new', 'pending-replay', 'settled-replay'] as const) {
  test(`active push rejects ${mode} send without consuming ID or sequence`, { timeout: 1000 }, async () => {
    const router = new Router();
    const a = session(router, endpoint('a'));
    let link = '';
    const id = mode === 'new' ? 'side' : mode === 'pending-replay' ? 'first' : 'old';
    const b = session(router, endpoint('b', 'codex'), async frame => {
      if (frame.messageId === 'first') {
        await assert.rejects(a.connection.send(request(link, id)), /REENTRANT_DELIVERY/);
      }
    });
    link = a.connection.connect('b');
    if (mode === 'settled-replay') await a.connection.send(request(link, 'old'));
    assert.equal((await a.connection.send(request(link, 'first'))).state, 'dispatched');
    assert.equal((await a.connection.send(request(link, id))).state, 'dispatched');
    assert.deepEqual(b.observed().map(f => f.sequence), mode === 'pending-replay' ? [1] : [1, 2]);
  });
}

test('simultaneous inbound callbacks reject replies instead of waiting on each other', { timeout: 1000 }, async () => {
  const router = new Router();
  let ac: ReturnType<typeof session>['connection'];
  let bc: ReturnType<typeof session>['connection'];
  const a = session(router, endpoint('a'), async frame => {
    await assert.rejects(ac.reply({ schemaVersion: 1, messageId: 're-' + frame.messageId,
      inReplyTo: frame.messageId, body: 'ack' }), /REENTRANT_DELIVERY/);
  });
  const b = session(router, endpoint('b', 'codex'), async frame => {
    await assert.rejects(bc.reply({ schemaVersion: 1, messageId: 're-' + frame.messageId,
      inReplyTo: frame.messageId, body: 'ack' }), /REENTRANT_DELIVERY/);
  });
  ac = a.connection; bc = b.connection;
  const link = ac.connect('b');
  const receipts = await Promise.all([ac.send(request(link, 'm1')), bc.send(request(link, 'n1'))]);
  assert.deepEqual(receipts.map(r => r.state), ['dispatched', 'dispatched']);
  assert.deepEqual(a.observed().map(f => f.messageId), ['n1']);
  assert.deepEqual(b.observed().map(f => f.messageId), ['m1']);
});

test('both sessions reply concurrently after inbound confirmation', { timeout: 1000 }, async () => {
  const router = new Router();
  const a = session(router, endpoint('a'));
  const b = session(router, endpoint('b', 'codex'));
  const link = a.connection.connect('b');
  const initial = await Promise.all([a.connection.send(request(link, 'm1')), b.connection.send(request(link, 'n1'))]);
  assert.deepEqual(initial.map(r => r.state), ['dispatched', 'dispatched']);
  const replies = await Promise.all([
    a.connection.reply({ schemaVersion: 1, messageId: 're-n1', inReplyTo: 'n1', body: 'ack A' }),
    b.connection.reply({ schemaVersion: 1, messageId: 're-m1', inReplyTo: 'm1', body: 'ack B' }),
  ]);
  assert.deepEqual(replies.map(r => r.state), ['dispatched', 'dispatched']);
  assert.deepEqual(a.observed().map(f => [f.messageId, f.sequence]), [['n1', 1], ['re-m1', 2]]);
  assert.deepEqual(b.observed().map(f => [f.messageId, f.sequence]), [['m1', 1], ['re-n1', 2]]);
});

test('deferred work after push completion does not inherit a stale reentry block', { timeout: 1000 }, async () => {
  const done = Promise.withResolvers<void>();
  const router = new Router();
  const a = session(router, endpoint('a'));
  let link = '';
  const b = session(router, endpoint('b', 'codex'), frame => {
    if (frame.messageId === 'first') setImmediate(() => {
      a.connection.send(request(link, 'later')).then(() => done.resolve(), done.reject);
    });
  });
  link = a.connection.connect('b');
  await a.connection.send(request(link, 'first'));
  await done.promise;
  assert.deepEqual(b.observed().map(x => x.messageId), ['first', 'later']);
});

test('unresponsive push stays pending in its direction until released; no deadline yet', async () => {
  const gate = Promise.withResolvers<void>();
  const router = new Router();
  const a = session(router, endpoint('a'));
  const b = session(router, endpoint('b', 'codex'), frame => frame.messageId === 'hang' ? gate.promise : undefined);
  const link = a.connection.connect('b');
  let completed = 0;
  const first = a.connection.send(request(link, 'hang')).then(() => { completed++; });
  const second = a.connection.send(request(link, 'queued')).then(() => { completed++; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(completed, 0);
    assert.deepEqual(b.observed().map(x => x.messageId), ['hang']);
    assert.equal((await b.connection.send(request(link, 'reverse'))).state, 'dispatched');
  } finally { gate.resolve(); }
  await Promise.all([first, second]);
  assert.equal(completed, 2);
});

test('explicit written outcome stays unknown, immutable and idempotent', async () => {
  const router = new Router();
  const a = session(router, endpoint('a'));
  let pushes = 0;
  const outcome = { state: 'delivery-unknown', transport: 'written' } as const;
  router.register(endpoint('b', 'claude-code'), () => { pushes++; return outcome; });
  const link = a.connection.connect('b');
  const receipt = await a.connection.send(request(link, 'written'));
  assert.equal(receipt.state, 'delivery-unknown');
  assert.equal(receipt.transport, 'written');
  assert.ok(Object.isFrozen(receipt));
  assert.deepEqual(await a.connection.send(request(link, 'written')), receipt);
  await a.connection.send(request(link, 'next'));
  assert.equal(pushes, 2);
});

test('missing or contradictory push confirmation cannot become dispatched', async () => {
  for (const result of [undefined, { state: 'dispatched', transport: 'written' },
    { state: 'read', transport: null }]) {
    const router = new Router();
    const a = session(router, endpoint('a'));
    router.register(endpoint('b', 'claude-code'), () => result as never);
    const receipt = await a.connection.send(request(a.connection.connect('b'), 'invalid'));
    assert.equal(receipt.state, 'delivery-unknown');
    assert.equal(receipt.transport, null);
  }
});
