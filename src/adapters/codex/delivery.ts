// INPUT: A v1 Envelope for a Codex thread, the owner pid/Codex home, a lock-holder lister and a queue opener.
// OUTPUT: Text under the shared inbound header queued into the original thread, an honest outcome, TARGET_OFFLINE, no-reply receipts.
// POS: Codex inbound seam; refuses offline owners instead of queueing (no offline replay) and claims no model read.
import { parseEnvelope, type Envelope, type PushOutcome } from '../../protocol/message.ts';
import { inboundText, REPLY_TOOLS } from '../../protocol/inbound-header.ts';
import { type QueueSession } from './app-server-queue.ts';
import { holdsWriterLock, parseThreadId, type HolderLister } from './thread-owner.ts';

export type DeliveryDeps = Readonly<{ codexHome: string; ownerPid: number; listHolders: HolderLister;
  openQueue: () => Promise<QueueSession> }>;
export type DeliveryResult = Readonly<{ outcome: PushOutcome; error: 'TARGET_OFFLINE' | null }>;

const SENDERS: readonly string[] = Object.freeze(['claude-code', 'dsh']);
const UNKNOWN: PushOutcome = Object.freeze({ state: 'delivery-unknown', transport: null });

export function codexInboundText(frame: Envelope, replyHint: boolean, senderLabel: string | null): string {
  if (!SENDERS.includes(frame.sender.harness)) throw new Error('INVALID_SOURCE');
  return inboundText(frame, { replyHint, senderLabel, replyTool: REPLY_TOOLS.codex });
}

export async function deliverToCodexThread(deps: DeliveryDeps, input: unknown, replyHint: boolean,
  senderLabel: string | null): Promise<DeliveryResult> {
  const frame = parseEnvelope(input);
  if (frame.recipient.harness !== 'codex') throw new Error('INVALID_TARGET');
  const threadId = parseThreadId(frame.recipient.nativeSessionId);
  const text = codexInboundText(frame, replyHint, senderLabel);
  const online = () => holdsWriterLock(deps.listHolders, deps.codexHome, threadId, deps.ownerPid);
  const offline = Object.freeze({ outcome: UNKNOWN, error: 'TARGET_OFFLINE' as const });
  if (!await online()) return offline;
  const session = await deps.openQueue();
  try {
    const queued = await session.add(threadId, text, frame.messageId);
    if (await online()) return Object.freeze({ outcome: Object.freeze({ state: 'dispatched', transport: null }), error: null });
    // The owner let go after the add: only a confirmed withdrawal proves the thread never received it.
    const withdrawn = await session.remove(threadId, queued.id).catch(() => false);
    return withdrawn ? offline : Object.freeze({ outcome: UNKNOWN, error: null });
  } finally { session.close(); }
}

// msd wants no result for a receipt, so there is nothing to withdraw or report; without the writer lock it is dropped.
export async function deliverReceiptToCodexThread(deps: DeliveryDeps, sessionId: string, receiptId: string, text: string): Promise<void> {
  const threadId = parseThreadId(sessionId);
  if (!await holdsWriterLock(deps.listHolders, deps.codexHome, threadId, deps.ownerPid)) return;
  const session = await deps.openQueue();
  try { await session.add(threadId, text, receiptId); } finally { session.close(); }
}
