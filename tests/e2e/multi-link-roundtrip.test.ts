// INPUT: Real Router registrations and synthetic Claude/DSH endpoints with deferred push replies.
// OUTPUT: Two-link interleaving, independent ordering and rejected cross-link delivery evidence.
// POS: Offline in-process integration; does not prove native Harness or model behavior.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEnvelope, type Envelope, type Receipt } from '../../src/protocol/message.ts';
import { Router, type Connection } from '../../src/router/router.ts';
import { endpoint, session } from '../helpers/session.ts';

const send = (linkId: string, messageId: string, body = messageId) =>
  ({ schemaVersion: 1, linkId, messageId, body });
const reply = (inReplyTo: string, messageId: string, body = messageId) =>
  ({ schemaVersion: 1, inReplyTo, messageId, body });

function twoLinks() {
  const router = new Router();
  const claude = session(router, endpoint('claude', 'claude-code'));
  const a = session(router, endpoint('dsh-a'));
  const b = session(router, endpoint('dsh-b'));
  const linkA = claude.connection.connect('dsh-a');
  const linkB = claude.connection.connect('dsh-b');
  assert.notEqual(linkA, linkB);
  return { claude, a, b, linkA, linkB };
}

test('two established links preserve six interleaved messages and deferred original-address replies',
  { timeout: 1000 }, async () => {
    const router = new Router();
    const claude = session(router, endpoint('claude', 'claude-code'));
    const replies = ['A-R1', 'B-R1', 'A-R2'].map(id =>
      [id, Promise.withResolvers<Receipt>()] as const);
    const completed = new Map(replies);
    let deliveries: readonly Envelope[] = [];
    const bodies = new Map([
      ['A-C1', ' A-C1 原样\n👋 '], ['A-R1', ' A-R1\n答复 '],
      ['B-C1', '\tB-C1 独立线路 '], ['B-R1', 'B-R1\n独立答复'],
      ['A-C2', ' A-C2 原址追问\n'], ['A-R2', '\nA-R2 完成 '],
    ]);
    function registerDsh(id: string, prefix: string) {
      let connection: Connection;
      connection = router.register(endpoint(id), frame => {
        const decoded = parseEnvelope(JSON.parse(JSON.stringify(frame)));
        deliveries = [...deliveries, decoded];
        const responseId = `${prefix}-R${decoded.messageId.slice(-1)}`;
        const response = completed.get(responseId)!;
        setImmediate(() => {
          connection.reply(reply(decoded.messageId, responseId, bodies.get(responseId)!))
            .then(response.resolve, response.reject);
        });
        return { state: 'dispatched', transport: null };
      });
      return connection;
    }
    const a = registerDsh('dsh-a', 'A');
    const b = registerDsh('dsh-b', 'B');
    const linkA = claude.connection.connect('dsh-a');
    const linkB = claude.connection.connect('dsh-b');
    assert.notEqual(linkA, linkB);
    assert.equal(a.connect('claude'), linkA);
    assert.equal(b.connect('claude'), linkB);
    const initial = await Promise.all([
      claude.connection.send(send(linkA, 'A-C1', bodies.get('A-C1')!)),
      claude.connection.send(send(linkB, 'B-C1', bodies.get('B-C1')!)),
    ]);
    assert.deepEqual(initial.map(receipt => receipt.state), ['dispatched', 'dispatched']);
    assert.equal(claude.observed().length, 0);
    const firstReplies = await Promise.all(replies.slice(0, 2).map(([, done]) => done.promise));
    const incomingA = claude.observed().find(frame => frame.messageId === 'A-R1')!;
    assert.ok(incomingA);
    assert.equal((await claude.connection.reply(
      reply(incomingA.messageId, 'A-C2', bodies.get('A-C2')!))).state, 'dispatched');
    const finalReply = await completed.get('A-R2')!.promise;
    assert.deepEqual([...firstReplies, finalReply].map(receipt => receipt.state),
      ['dispatched', 'dispatched', 'dispatched']);
    const frames = [...deliveries, ...claude.observed()];
    const expected = [
      ['A-C1', linkA, 'claude', 'dsh-a', null, 1],
      ['B-C1', linkB, 'claude', 'dsh-b', null, 1],
      ['A-R1', linkA, 'dsh-a', 'claude', 'A-C1', 1],
      ['B-R1', linkB, 'dsh-b', 'claude', 'B-C1', 1],
      ['A-C2', linkA, 'claude', 'dsh-a', 'A-R1', 2],
      ['A-R2', linkA, 'dsh-a', 'claude', 'A-C2', 2],
    ] as const;
    assert.equal(frames.length, 6);
    for (const [id, link, sender, recipient, inReplyTo, sequence] of expected) {
      const frame = frames.find(item => item.messageId === id)!;
      assert.ok(frame, id);
      assert.equal(frame.linkId, link);
      assert.deepEqual(frame.sender, endpoint(sender, sender === 'claude' ? 'claude-code' : 'dsh'));
      assert.deepEqual(frame.recipient, endpoint(recipient, recipient === 'claude' ? 'claude-code' : 'dsh'));
      assert.deepEqual(frame.replyTo, frame.sender);
      assert.equal(frame.inReplyTo, inReplyTo);
      assert.equal(frame.sequence, sequence);
      assert.equal(frame.body, bodies.get(id));
      assert.equal(frame.authority, 'none');
      assert.equal(frame.source, 'peer');
    }
    assert.deepEqual(deliveries.filter(frame => frame.recipient.endpointId === 'dsh-b')
      .map(frame => frame.messageId), ['B-C1']);
  });

test('a blocked Claude-to-A queue preserves order while link B completes both directions',
  { timeout: 1000 }, async () => {
    const router = new Router();
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const claude = session(router, endpoint('claude', 'claude-code'));
    const a = session(router, endpoint('dsh-a'), frame => {
      if (frame.messageId === 'A-C1') { entered.resolve(); return gate.promise; }
    });
    const b = session(router, endpoint('dsh-b'));
    const linkA = claude.connection.connect('dsh-a');
    const linkB = claude.connection.connect('dsh-b');
    let settled = 0;
    const first = claude.connection.send(send(linkA, 'A-C1')).then(() => { settled++; });
    const second = claude.connection.send(send(linkA, 'A-C2')).then(() => { settled++; });
    try {
      await entered.promise;
      assert.equal((await claude.connection.send(send(linkB, 'B-C1'))).state, 'dispatched');
      assert.equal((await b.connection.reply(reply('B-C1', 'B-R1'))).state, 'dispatched');
      assert.equal(settled, 0);
      assert.deepEqual(a.observed().map(frame => frame.messageId), ['A-C1']);
      assert.deepEqual(b.observed().map(frame => [frame.messageId, frame.sequence]), [['B-C1', 1]]);
      assert.deepEqual(claude.observed().map(frame => [frame.messageId, frame.linkId, frame.sequence]),
        [['B-R1', linkB, 1]]);
    } finally { gate.resolve(); }
    await Promise.all([first, second]);
    assert.equal(settled, 2);
    assert.deepEqual(a.observed().map(frame => [frame.messageId, frame.sequence]),
      [['A-C1', 1], ['A-C2', 2]]);
  });

const invalidCases = [
  { name: 'unknown link', error: /UNKNOWN_LINK/,
    attempt: ({ claude }: ReturnType<typeof twoLinks>) =>
      claude.connection.send(send('missing-link', 'invalid')) },
  { name: 'DSH B is not a member of link A', error: /NOT_A_MEMBER/,
    attempt: ({ b, linkA }: ReturnType<typeof twoLinks>) => b.connection.send(send(linkA, 'invalid')) },
  { name: 'DSH B cannot reply to A incoming message', error: /NOT_RECIPIENT/,
    attempt: ({ b }: ReturnType<typeof twoLinks>) => b.connection.reply(reply('A-C1', 'invalid')) },
  { name: 'reply cannot override the original link', error: /INVALID_/,
    attempt: ({ claude, linkB }: ReturnType<typeof twoLinks>) =>
      claude.connection.reply({ ...reply('A-R1', 'invalid'), linkId: linkB }) },
  { name: 'reply cannot override the original endpoint', error: /INVALID_/,
    attempt: ({ claude }: ReturnType<typeof twoLinks>) =>
      claude.connection.reply({ ...reply('A-R1', 'invalid'), replyTo: endpoint('dsh-b') }) },
  { name: 'same message ID conflicts across links', error: /MESSAGE_ID_CONFLICT/,
    attempt: ({ claude, linkB }: ReturnType<typeof twoLinks>) =>
      claude.connection.send(send(linkB, 'A-C1')) },
];

for (const invalid of invalidCases) {
  test(`two-link rejection: ${invalid.name} neither misdelivers nor consumes sequence`, async () => {
    const context = twoLinks();
    const { claude, a, b, linkA, linkB } = context;
    await claude.connection.send(send(linkA, 'A-C1'));
    await a.connection.reply(reply('A-C1', 'A-R1'));
    await assert.rejects(invalid.attempt(context), invalid.error);
    assert.deepEqual(a.observed().map(frame => frame.messageId), ['A-C1']);
    assert.deepEqual(b.observed(), []);
    assert.deepEqual(claude.observed().map(frame => frame.messageId), ['A-R1']);
    await claude.connection.reply(reply('A-R1', 'A-C2'));
    await claude.connection.send(send(linkB, 'B-C1'));
    await b.connection.reply(reply('B-C1', 'B-R1'));
    assert.deepEqual(a.observed().map(frame => [frame.messageId, frame.linkId, frame.sequence]),
      [['A-C1', linkA, 1], ['A-C2', linkA, 2]]);
    assert.deepEqual(b.observed().map(frame => [frame.messageId, frame.linkId, frame.sequence]),
      [['B-C1', linkB, 1]]);
    assert.deepEqual(claude.observed().map(frame => [frame.messageId, frame.linkId, frame.sequence]),
      [['A-R1', linkA, 1], ['B-R1', linkB, 1]]);
  });
}
