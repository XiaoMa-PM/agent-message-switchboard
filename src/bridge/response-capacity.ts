// INPUT: Strict business requests and target IDs supplied by the trusted registry.
// OUTPUT: Full RPC and native Post-hook response capacity rejection before dispatch.
// POS: Pure compact-response preflight; no routing, identity, private data or dispatch.
import { parseBridgeRequest, type BridgeRequest } from './skill-request.ts';
import { CLAUDE_DELIVERY_NOTES, type ClaudeChannelResult } from './claude-channel.ts';
import { encodeIpcFrame, MAX_FRAME_BYTES } from './ipc-frame.ts';

const UUID = '00000000-0000-0000-0000-000000000000';

function targets(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.length === 0) throw new Error('UNKNOWN_TARGET');
  const snapshot: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string' || !value.trim()) throw new Error('INVALID_TARGET');
    snapshot.push(value);
  }
  return Object.freeze(snapshot);
}

function assertCompleteResult(result: ClaudeChannelResult): void {
  encodeIpcFrame({ schemaVersion: 1, requestId: UUID, ok: true, result });
  const native = JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PostToolUse', additionalContext: JSON.stringify(result) } });
  if (Buffer.byteLength(native) > MAX_FRAME_BYTES) throw new Error('IPC_FRAME_TOO_LARGE');
}

export function assertResponseCapacity(input: BridgeRequest, targetSessionIds: readonly string[]): void {
  const request = parseBridgeRequest(input);
  if (request.operation === 'list') throw new Error('INVALID_BRIDGE_REQUEST');
  if (request.operation === 'connect') {
    assertCompleteResult({ linkId: UUID, targetSessionId: request.targetSessionId });
    return;
  }
  const candidates = targets(targetSessionIds);
  const linkIds = request.operation === 'send' ? [UUID, request.linkId] : [UUID];
  for (const targetSessionId of candidates) {
    for (const linkId of linkIds) {
      for (const deliveryNote of Object.values(CLAUDE_DELIVERY_NOTES)) {
        assertCompleteResult({ receipt: { messageId: request.messageId, state: 'delivery-unknown',
          transport: 'written', sequence: Number.MAX_SAFE_INTEGER, linkId, targetSessionId }, deliveryNote });
      }
    }
  }
}
