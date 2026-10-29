// INPUT: Synthetic original letters (messageId, recipient harness, session id, directory label) and the five settlement reasons.
// OUTPUT: Contract for the no-reply receipt text: the exact header and sentences per reason, the label (alias or title,
//         capped at 64 characters, else the session id), JSON escaping of every value, and that no harness's letter detection
//         mistakes a receipt for a letter.
// POS: Pure contract for src/protocol/receipt-text.ts; no I/O.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RECEIPT_PREFIX, RECEIPT_REASONS, receiptText } from '../../src/protocol/receipt-text.ts';
import { parseInboundText } from '../../src/protocol/inbound-header.ts';
import { isLetterPrompt } from '../../src/daemon/claude-skill.ts';

const TAIL = '之后对方仍可能回信。这条回执由 Switchboard 代发：不要回复它，也不要自动重发原消息；请把情况告诉用户，由用户决定下一步。';
const SENTENCES = {
  ended: '对方这一轮正常结束，但没有调用回信。',
  interrupted: '这一轮可能被对方的用户中断，或对方的用户拒绝了其中的操作。',
  failed: '对方这一轮出错结束。',
  closed: '对方会话已经结束或退出。',
  unknown: '结束原因不明。',
} as const;

test('the receipt is a fixed header and one sentence per reason, naming the recipient by its label', () => {
  assert.equal(RECEIPT_PREFIX, 'Switchboard 回执');
  assert.deepEqual([...RECEIPT_REASONS], ['ended', 'interrupted', 'failed', 'closed', 'unknown']);
  for (const reason of RECEIPT_REASONS) {
    assert.equal(receiptText({ letterId: 'm-1', harness: 'codex', sessionId: 'thread-9', label: '评审', reason }),
      'Switchboard 回执 · 不是对方的回信 · 原消息 messageId "m-1"\n'
      + `你发给 Codex 会话 "评审" 的消息已送达，对方处理它的那一轮已经结束，结束时没有回信。${SENTENCES[reason]}${TAIL}`, reason);
  }
});

test('without a label the session id is named; a label is capped at 64 characters; every value is JSON-escaped', () => {
  assert.ok(receiptText({ letterId: 'm-2', harness: 'claude-code', sessionId: 's"1', label: null, reason: 'ended' }).split('\n')[1]
    .startsWith('你发给 Claude Code 会话 ID "s\\"1" 的消息已送达，'));
  const long = receiptText({ letterId: 'm-3', harness: 'dsh', sessionId: 'D1', label: '长'.repeat(70), reason: 'ended' });
  assert.ok(long.includes(`会话 "${'长'.repeat(63)}…"`), 'capped like the inbound header label');
  const odd = receiptText({ letterId: 'm-4', harness: 'dsh', sessionId: 'D1', label: 'a b"c\nd', reason: 'failed' });
  assert.ok(odd.includes('会话 "a\\u2028b\\"c\\nd"'));
  assert.equal(odd.split('\n').length, 2, 'no value can add a line');
  assert.ok(receiptText({ letterId: 'x ', harness: 'dsh', sessionId: 'D1', label: 'l', reason: 'ended' })
    .startsWith('Switchboard 回执 · 不是对方的回信 · 原消息 messageId "x\\u2029"'));
});

test('a receipt never passes for a letter: not a header any harness detects, and not parseable as one', () => {
  for (const reason of RECEIPT_REASONS) {
    const text = receiptText({ letterId: 'm-5', harness: 'claude-code', sessionId: 'S1', label: 'x', reason });
    assert.equal(parseInboundText(text), null);
    assert.equal(isLetterPrompt(text), false);
    assert.ok(!text.startsWith('来源：'), 'every letter header starts with 来源：');
  }
});
