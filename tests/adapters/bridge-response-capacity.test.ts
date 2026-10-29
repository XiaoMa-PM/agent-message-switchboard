// INPUT: Synthetic business requests, trusted target-ID fixtures and compact public receipts.
// OUTPUT: Full RPC/native-hook capacity and pre-dispatch rejection regressions.
// POS: Pure response capacity tests; no host, socket, identity proof or model call.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_FRAME_BYTES, encodeIpcFrame } from '../../src/bridge/ipc-frame.ts';
import { CLAUDE_DELIVERY_NOTES, createClaudeChannel, type ClaudeChannelResult } from '../../src/bridge/claude-channel.ts';
import { type BridgeRequest } from '../../src/bridge/skill-request.ts';
import { type EpochBinding } from '../../src/adapters/claude/session-epoch.ts';
import { assertResponseCapacity } from '../../src/bridge/response-capacity.ts';

const uuid = '00000000-0000-0000-0000-000000000000';
const send: BridgeRequest = { schemaVersion: 1, operation: 'send', messageId: 'm', linkId: uuid, body: '正文😀' };
const reply: BridgeRequest = { schemaVersion: 1, operation: 'reply', messageId: 'r', inReplyTo: 'original', body: '' };
const connect: BridgeRequest = { schemaVersion: 1, operation: 'connect', targetSessionId: 'target' };

function publicResult(request: Exclude<BridgeRequest, { operation: 'list' }>, target: string, note: string = CLAUDE_DELIVERY_NOTES.unknown): ClaudeChannelResult {
  if (request.operation === 'connect') return { linkId: uuid, targetSessionId: request.targetSessionId };
  return { receipt: { messageId: request.messageId, state: 'delivery-unknown', transport: 'written',
    sequence: Number.MAX_SAFE_INTEGER, linkId: request.operation === 'send' ? request.linkId : uuid,
    targetSessionId: target }, deliveryNote: note };
}

function sizes(result: ClaudeChannelResult) {
  const rpc = JSON.stringify({ schemaVersion: 1, requestId: uuid, ok: true, result });
  const hook = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: JSON.stringify(result) } });
  return { rpc: 4 + Buffer.byteLength(rpc), hook: Buffer.byteLength(hook) };
}

function maxAsciiId(request: Exclude<BridgeRequest, { operation: 'connect' | 'list' }>, target: string): number {
  const size = sizes(publicResult({ ...request, messageId: '' }, target));
  return Math.min(MAX_FRAME_BYTES - size.rpc, MAX_FRAME_BYTES - size.hook);
}

test('ordinary compact connect send and reply pass without returning a payload', async () => {
  assert.equal(assertResponseCapacity(connect, []), undefined);
  for (const request of [send, reply]) assert.equal(assertResponseCapacity(request, ['short-target']), undefined);
});

test('near-boundary message IDs fit exactly and one more byte fails', async () => {
  for (const request of [send, reply] as const) {
    const length = maxAsciiId(request, 'short-target');
    const fitting = { ...request, messageId: 'm'.repeat(length) };
    const size = sizes(publicResult(fitting, 'short-target'));
    assert.equal(Math.max(size.rpc, size.hook), MAX_FRAME_BYTES);
    assertResponseCapacity(fitting, ['short-target']);
    assert.throws(() => assertResponseCapacity({ ...fitting, messageId: fitting.messageId + 'm' }, ['short-target']),
      /^Error: IPC_FRAME_TOO_LARGE$/);
  }
});

test('full RPC wrapper must fit even when the inner connect result fits', async () => {
  const request = { ...connect, targetSessionId: 't'.repeat(MAX_FRAME_BYTES - 100) };
  const result = publicResult(request, 'ignored');
  assert.ok(encodeIpcFrame(result).length <= MAX_FRAME_BYTES);
  assert.ok(sizes(result).rpc > MAX_FRAME_BYTES);
  assert.throws(() => assertResponseCapacity(request, []), /^Error: IPC_FRAME_TOO_LARGE$/);
});

test('double JSON escaping can overflow the native hook after a valid RPC frame', async () => {
  const request = { ...send, messageId: '"'.repeat(300000) };
  const result = publicResult(request, 'target');
  assert.ok(sizes(result).rpc < MAX_FRAME_BYTES);
  assert.ok(sizes(result).hook > MAX_FRAME_BYTES);
  assert.throws(() => assertResponseCapacity(request, ['target']), /^Error: IPC_FRAME_TOO_LARGE$/);
});

test('single-layer longest target cannot hide a shorter double-layer overflow', async () => {
  const ordinary = 'a'.repeat(600000);
  const escaped = '"'.repeat(299999);
  assert.ok(Buffer.byteLength(JSON.stringify(ordinary)) > Buffer.byteLength(JSON.stringify(escaped)));
  assert.ok(Math.max(...Object.values(sizes(publicResult(send, ordinary)))) < MAX_FRAME_BYTES);
  assert.ok(sizes(publicResult(send, escaped)).hook > MAX_FRAME_BYTES);
  assert.throws(() => assertResponseCapacity(send, [ordinary, escaped]), /^Error: IPC_FRAME_TOO_LARGE$/);
  assert.throws(() => assertResponseCapacity(reply, [escaped, ordinary]), /^Error: IPC_FRAME_TOO_LARGE$/);
});

test('connect measures its exact target and send/reply measure all trusted candidates', async () => {
  assertResponseCapacity(connect, ['"'.repeat(MAX_FRAME_BYTES)]);
  for (const request of [send, reply]) {
    assert.throws(() => assertResponseCapacity(request, ['safe', 't'.repeat(MAX_FRAME_BYTES)]), /^Error: IPC_FRAME_TOO_LARGE$/);
    assert.throws(() => assertResponseCapacity(request, ['t'.repeat(MAX_FRAME_BYTES), 'safe']), /^Error: IPC_FRAME_TOO_LARGE$/);
    assertResponseCapacity(request, ['中文😀\\"', 'short']);
  }
});

test('reply does not echo inReplyTo, body or a model-supplied target address', async () => {
  assertResponseCapacity({ ...reply, inReplyTo: 'prior'.repeat(MAX_FRAME_BYTES), body: 'private'.repeat(MAX_FRAME_BYTES) }, ['safe']);
  assertResponseCapacity({ ...send, body: 'private-body😀'.repeat(MAX_FRAME_BYTES) }, ['safe']);
  assert.throws(() => assertResponseCapacity({ ...reply, targetSessionId: 'forged' } as unknown as BridgeRequest, ['safe']),
    /^Error: INVALID_BRIDGE_REQUEST$/);
});

test('send link capacity considers original encoded ID and a generated UUID floor', async () => {
  const fitting = { ...send, messageId: 'm'.repeat(maxAsciiId(send, 'target')), linkId: 'l' };
  assertResponseCapacity(fitting, ['target']);
  assert.throws(() => assertResponseCapacity({ ...fitting, linkId: '"'.repeat(17) }, ['target']), /^Error: IPC_FRAME_TOO_LARGE$/);
  assert.throws(() => assertResponseCapacity({ ...send, linkId: 'l'.repeat(MAX_FRAME_BYTES) }, ['target']), /^Error: IPC_FRAME_TOO_LARGE$/);
});

test('empty or malformed target candidates are rejected without dropping bad entries', async () => {
  for (const request of [send, reply]) {
    assert.throws(() => assertResponseCapacity(request, []), /^Error: UNKNOWN_TARGET$/);
    for (const targets of [['safe', ''], [' ', 'safe'], ['safe', 1], null]) {
      assert.throws(() => assertResponseCapacity(request, targets as unknown as readonly string[]), /UNKNOWN_TARGET|INVALID_TARGET/);
    }
  }
});

test('requests use the original strict parser before capacity work', async () => {
  for (const request of [null, {}, { ...send, schemaVersion: 2 }, { ...send, sender: 'forged' },
    { ...connect, pid: 1 }, { ...reply, authority: 'user' }, { ...send, messageId: ' ' }]) {
    assert.throws(() => assertResponseCapacity(request as BridgeRequest, ['target']), /^Error: INVALID_BRIDGE_REQUEST$/);
  }
});

test('each delivery note fits under the conservative preflight result', async () => {
  const fitting = { ...send, messageId: 'm'.repeat(maxAsciiId(send, 'target')) };
  assertResponseCapacity(fitting, ['target']);
  for (const note of Object.values(CLAUDE_DELIVERY_NOTES)) {
    const result = publicResult(fitting, 'target', note);
    assert.ok(sizes(result).rpc <= MAX_FRAME_BYTES); assert.ok(sizes(result).hook <= MAX_FRAME_BYTES);
  }
});

function epoch(): EpochBinding {
  const endpoint = Object.freeze({ schemaVersion: 1 as const, endpointId: 'claude-epoch:synthetic',
    harness: 'claude-code' as const, storageNamespace: 'a'.repeat(64), nativeSessionId: 'sid',
    hostInstanceId: 'host', routeGeneration: 'route' });
  return Object.freeze({ identity: { pid: 50, uid: 501, uniqueId: '500', pidVersion: 1 },
    nativeSessionId: 'sid', epoch: 'synthetic', endpoint,
    route: { schemaVersion: 1 as const, endpoint, socket: '/synthetic/socket', ownerPid: 50, ownerStart: 'start' } });
}

test('capacity overflow rejects Claude Post before acquiring any business connection', async () => {
  let acquired = 0; const binding = epoch();
  const channel = createClaudeChannel({ assertOpen: () => {}, verify: async () => {}, assertCurrent: () => undefined,
    beforeDispatch: (_binding, request) => assertResponseCapacity(request, ['"'.repeat(300000)]),
    getConnection: () => { acquired += 1; throw new Error('MUST_NOT_DISPATCH'); } });
  const native = { session_id: 'sid', transcript_path: '/synthetic/transcript', cwd: '/synthetic/cwd',
    tool_name: 'Skill', tool_use_id: 'call', tool_input: { skill: 'agent-message-switchboard:message', args: JSON.stringify(send) } };
  await channel.pre(binding, { ...native, hook_event_name: 'PreToolUse' });
  await assert.rejects(channel.post(binding, { ...native, hook_event_name: 'PostToolUse',
    tool_response: { success: true, commandName: 'agent-message-switchboard:message' } }), /^Error: IPC_FRAME_TOO_LARGE$/);
  assert.equal(acquired, 0);
});

test('business receipt preflight never claims to preflight a directory result', () => {
  assert.throws(() => assertResponseCapacity({ schemaVersion: 1, operation: 'list', harness: 'dsh' }, []), /INVALID_BRIDGE_REQUEST/);
});
