// INPUT: Synthetic registrations with passive push and notice callbacks, a fake clock and memory state stores.
// OUTPUT: Switchboard contract: the answered-letter index (built on load, kept on save; pending,
//         delivery-unknown and dispatched replies count, undelivered ones do not), letterTurnEnded outcomes (answered, receipted,
//         duplicate, ignored, dropped) with the receipt text pushed through notice, and the structural loop guards.
// POS: Offline daemon core tests; no socket, host or model.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSwitchboard, type Sender, type SendResult } from '../../src/daemon/switchboard.ts';
import { createMemoryStore, type PersistedState } from '../../src/daemon/state-store.ts';
import { type Notice } from '../../src/daemon/directory.ts';
import { type Envelope, type Harness, type PushOutcome } from '../../src/protocol/message.ts';
import { receiptText } from '../../src/protocol/receipt-text.ts';

const dispatched: PushOutcome = Object.freeze({ state: 'dispatched', transport: null });
type PushFn = (frame: Envelope) => Promise<PushOutcome>;

function fixture(initial?: PersistedState, budget = { windowSeconds: 600, maxPushes: 30 }) {
  const store = createMemoryStore(initial);
  const board = createSwitchboard({ now: () => Date.parse('2026-10-27T00:00:00.000Z'), store, budget });
  const notices = new Map<string, Notice[]>();
  const join = (harness: Harness, sessionId: string, extra: { title?: string; push?: PushFn; notice?: (notice: Notice) => Promise<void> } = {}): Sender => {
    const seen = notices.get(sessionId) ?? []; notices.set(sessionId, seen);
    const online = board.register({ harness, sessionId, clientSurface: 'cli', title: extra.title ?? `title-${sessionId}`, cwd: null,
      project: null, push: extra.push ?? (async () => dispatched), verify: async () => {},
      notice: extra.notice ?? (async notice => { seen.push(notice); }) });
    return Object.freeze({ harness, sessionId, generation: online.generation });
  };
  return { board, store, join, notices: (sessionId: string) => notices.get(sessionId) ?? [] };
}
const sent = (result: SendResult) => (result as Extract<SendResult, { sent: true }>).receipt;
const ref = (sender: Sender) => ({ harness: sender.harness, sessionId: sender.sessionId });

test('an unanswered letter gets one receipt through notice; a second settlement is a duplicate', async () => {
  const f = fixture();
  const dsh = f.join('dsh', 'D1'); const codex = f.join('codex', 'X1', { title: '评审' });
  const letter = sent(await f.board.send(dsh, { harness: 'codex', target: 'X1', body: '请跑测试', messageId: 'm-1' }));
  assert.deepEqual(f.board.letterTurnEnded(ref(codex), [letter.messageId], 'interrupted'), [{ messageId: 'm-1', outcome: 'receipted' }]);
  const [notice] = f.notices('D1');
  assert.equal(notice.letterId, 'm-1');
  assert.match(notice.receiptId, /^[0-9a-f-]{36}$/);
  assert.equal(notice.text, receiptText({ letterId: 'm-1', harness: 'codex', sessionId: 'X1', label: '评审', reason: 'interrupted' }));
  assert.ok(Object.isFrozen(notice));
  assert.deepEqual(f.board.letterTurnEnded(ref(codex), ['m-1'], 'ended'), [{ messageId: 'm-1', outcome: 'duplicate' }]);
  assert.equal(f.notices('D1').length, 1);
  assert.deepEqual(f.notices('X1'), [], 'the recipient never gets one');
});

test('a reply from the recipient counts once saved, pending included; an undelivered or foreign reply does not', async () => {
  const f = fixture();
  let release = (_: PushOutcome) => {};
  const claude = f.join('claude-code', 'C1', { push: () => new Promise(resolve => { release = resolve; }) });
  const dsh = f.join('dsh', 'D1'); const other = f.join('dsh', 'D2');
  sent(await f.board.send(claude, { harness: 'dsh', target: 'D1', body: 'a', messageId: 'a' }));
  const pending = f.board.reply(dsh, { inReplyTo: 'a', body: '收到' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.board.letterTurnEnded(ref(dsh), ['a'], 'ended'), [{ messageId: 'a', outcome: 'answered' }], 'pending counts');
  release(dispatched); await pending;
  const lost = f.join('codex', 'X1', { push: async () => { throw new Error('SOCKET_RESET'); } });
  sent(await f.board.send(lost, { harness: 'dsh', target: 'D1', body: 'u', messageId: 'u' }));
  assert.equal(sent(await f.board.reply(dsh, { inReplyTo: 'u', body: '收到' })).state, 'delivery-unknown');
  assert.deepEqual(f.board.letterTurnEnded(ref(dsh), ['u'], 'ended'), [{ messageId: 'u', outcome: 'answered' }], 'delivery-unknown counts');
  sent(await f.board.send(claude, { harness: 'dsh', target: 'D1', body: 'b', messageId: 'b' }));
  await assert.rejects(f.board.reply(other, { inReplyTo: 'b', body: 'x' }), /NOT_RECIPIENT/);
  assert.deepEqual(f.board.letterTurnEnded(ref(dsh), ['b'], 'ended'), [{ messageId: 'b', outcome: 'receipted' }], 'a foreign reply is no reply');
  const g = fixture();
  const sender = g.join('claude-code', 'C1', { push: async () => { throw new Error('TARGET_OFFLINE'); } });
  const recipient = g.join('codex', 'X1');
  sent(await g.board.send(sender, { harness: 'codex', target: 'X1', body: 'c', messageId: 'c' }));
  await assert.rejects(g.board.reply(recipient, { inReplyTo: 'c', body: 'r' }), /TARGET_OFFLINE/);
  assert.deepEqual(g.board.letterTurnEnded(ref(recipient), ['c'], 'ended'), [{ messageId: 'c', outcome: 'receipted' }],
    'a reply that went pending, then undelivered, leaves the index');
});

test('the answered index is rebuilt from the stored messages on load', async () => {
  const f = fixture();
  const claude = f.join('claude-code', 'C1'); const dsh = f.join('dsh', 'D1');
  sent(await f.board.send(claude, { harness: 'dsh', target: 'D1', body: 'a', messageId: 'a' }));
  sent(await f.board.send(claude, { harness: 'dsh', target: 'D1', body: 'b', messageId: 'b' }));
  sent(await f.board.reply(dsh, { inReplyTo: 'a', body: 'r' }));
  const state = f.store.load();
  const g = fixture(state);
  g.join('claude-code', 'C1'); const again = g.join('dsh', 'D1');
  assert.deepEqual(g.board.letterTurnEnded(ref(again), ['a', 'b'], 'ended'),
    [{ messageId: 'a', outcome: 'answered' }, { messageId: 'b', outcome: 'receipted' }]);
});

test('letters that are not this recipient\'s open letters are ignored; an offline sender or a paused link drops the receipt', async () => {
  const f = fixture();
  const claude = f.join('claude-code', 'C1'); const dsh = f.join('dsh', 'D1'); const codex = f.join('codex', 'X1');
  sent(await f.board.send(claude, { harness: 'dsh', target: 'D1', body: 'a', messageId: 'a' }));
  sent(await f.board.send(claude, { harness: 'codex', target: 'X1', body: 'x', messageId: 'x' }));
  const reply = sent(await f.board.reply(dsh, { inReplyTo: 'a', body: 'r' }));
  assert.deepEqual(f.board.letterTurnEnded(ref(dsh), ['missing', 'x', reply.messageId], 'ended').map(item => item.outcome),
    ['ignored', 'ignored', 'ignored'], 'unknown, another recipient\'s, a reply');
  assert.deepEqual(f.board.letterTurnEnded(ref(claude), [reply.messageId], 'ended'), [{ messageId: reply.messageId, outcome: 'ignored' }],
    'a reply never gets a receipt, even at its own recipient');
  sent(await f.board.send(claude, { harness: 'dsh', target: 'D1', body: 'b', messageId: 'b' }));
  f.board.unregister(ref(claude), claude.generation);
  assert.deepEqual(f.board.letterTurnEnded(ref(dsh), ['b'], 'ended'), [{ messageId: 'b', outcome: 'dropped' }]);
  assert.deepEqual(f.board.letterTurnEnded(ref(dsh), ['b'], 'ended'), [{ messageId: 'b', outcome: 'duplicate' }], 'settled once');
  assert.deepEqual(f.notices('C1'), []);
  const g = fixture(undefined, { windowSeconds: 600, maxPushes: 1 });
  const sender = g.join('claude-code', 'C1'); const recipient = g.join('dsh', 'D1');
  sent(await g.board.send(sender, { harness: 'dsh', target: 'D1', body: 'p', messageId: 'p' }));
  await assert.rejects(g.board.send(sender, { harness: 'dsh', target: 'D1', body: 'q' }), /LINK_PAUSED/);
  assert.deepEqual(g.board.letterTurnEnded(ref(recipient), ['p'], 'ended'), [{ messageId: 'p', outcome: 'dropped' }]);
  assert.deepEqual(g.notices('C1'), []);
});

test('several letters settle in one call; a throwing notice is swallowed; receipts are neither messages nor budget', async () => {
  const f = fixture(undefined, { windowSeconds: 600, maxPushes: 4 });
  const claude = f.join('claude-code', 'C1', { notice: async () => { throw new Error('INBOX_WRITE_FAILED'); } });
  const dsh = f.join('dsh', 'D1');
  for (const id of ['a', 'b', 'c']) sent(await f.board.send(claude, { harness: 'dsh', target: 'D1', body: id, messageId: id }));
  assert.deepEqual(f.board.letterTurnEnded(ref(dsh), ['a', 'b', 'c'], 'failed').map(item => item.outcome), ['receipted', 'receipted', 'receipted']);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.board.messages({}).map(row => row.messageId), ['c', 'b', 'a']);
  assert.equal(f.board.links()[0].messages, 3);
  assert.equal(f.board.links()[0].paused, false);
  // The fourth push fits the budget of four only because the three receipts were not charged.
  sent(await f.board.reply(dsh, { inReplyTo: 'a', body: 'r' }));
});

test('a receipt cannot be replied to or verified as a letter, and the real reply still goes through after it', async () => {
  const f = fixture();
  const claude = f.join('claude-code', 'C1'); const dsh = f.join('dsh', 'D1');
  sent(await f.board.send(claude, { harness: 'dsh', target: 'D1', body: 'a', messageId: 'a' }));
  f.board.letterTurnEnded(ref(dsh), ['a'], 'ended');
  const [notice] = f.notices('C1');
  await assert.rejects(f.board.reply(claude, { inReplyTo: notice.receiptId, body: '收到' }), /UNKNOWN_MESSAGE/);
  await assert.rejects(f.board.reply(claude, { inReplyTo: 'a', body: '收到' }), /NOT_RECIPIENT/);
  assert.throws(() => f.board.verifyLetter(ref(claude), notice.text), /NOT_A_LETTER/);
  const late = sent(await f.board.reply(dsh, { inReplyTo: 'a', body: '补回' }));
  assert.equal(late.targetSessionId, 'C1');
});

test('a registration without a notice callback is refused', () => {
  const f = fixture();
  assert.throws(() => f.board.register({ harness: 'dsh', sessionId: 'D1', clientSurface: 'desktop', title: null, cwd: null, project: null,
    push: async () => dispatched, verify: async () => {} } as never), /INVALID_REQUEST/);
});
