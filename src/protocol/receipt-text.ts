// INPUT: An original letter (messageId, recipient harness and session id, sender-side label) and the reason its letter turn ended.
// OUTPUT: RECEIPT_PREFIX, RECEIPT_REASONS, ReceiptReason, isReceiptReason, receiptText (the no-reply receipt msd pushes to the sender).
// POS: Shared fixed copy for the no-reply receipt; it never starts like a letter header, so no harness takes it for one. No I/O.
import { cappedLabel, HARNESS_NAMES, headerValue } from './inbound-header.ts';
import { type Harness } from './message.ts';

export const RECEIPT_PREFIX = 'Switchboard 回执';
export const RECEIPT_REASONS = Object.freeze(['ended', 'interrupted', 'failed', 'closed', 'unknown'] as const);
export type ReceiptReason = (typeof RECEIPT_REASONS)[number];
export const isReceiptReason = (value: unknown): value is ReceiptReason => RECEIPT_REASONS.includes(value as ReceiptReason);

// interrupted keeps "or the user refused one of its operations": Claude's No ends a turn the same way.
const SENTENCES: Readonly<Record<ReceiptReason, string>> = Object.freeze({
  ended: '对方这一轮正常结束，但没有调用回信。',
  interrupted: '这一轮可能被对方的用户中断，或对方的用户拒绝了其中的操作。',
  failed: '对方这一轮出错结束。',
  closed: '对方会话已经结束或退出。',
  unknown: '结束原因不明。',
});

export type ReceiptInput = Readonly<{ letterId: string; harness: Harness; sessionId: string; label: string | null; reason: ReceiptReason }>;

export function receiptText(input: ReceiptInput): string {
  const session = input.label === null ? `会话 ID ${headerValue(input.sessionId)}` : `会话 ${headerValue(cappedLabel(input.label))}`;
  return `${RECEIPT_PREFIX} · 不是对方的回信 · 原消息 messageId ${headerValue(input.letterId)}\n`
    + `你发给 ${HARNESS_NAMES[input.harness]} ${session} 的消息已送达，对方处理它的那一轮已经结束，结束时没有回信。`
    + `${SENTENCES[input.reason]}之后对方仍可能回信。这条回执由 Switchboard 代发：不要回复它，也不要自动重发原消息；请把情况告诉用户，`
    + '由用户决定下一步。';
}
