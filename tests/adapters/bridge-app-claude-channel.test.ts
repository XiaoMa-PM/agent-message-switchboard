// INPUT: Authenticated epoch fixtures, native Skill hooks and counted pure transport callbacks.
// OUTPUT: Pre/Post correlation, single dispatch, capacity and closed-cache regressions.
// POS: Pure authenticated-channel tests; no IPC, permission decisions or model calls.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAppClaudeChannel, type ClaudeChannelConnection } from '../../src/bridge/claude-channel.ts';
import { encodeIpcFrame, MAX_FRAME_BYTES } from '../../src/bridge/ipc-frame.ts';
import { createAppSkillProfile, type BridgeRequest } from '../../src/bridge/skill-request.ts';
import { ClaudeSessionEpochs } from '../../src/adapters/claude/session-epoch.ts';
import { type Receipt } from '../../src/protocol/message.ts';

const sid = '00000000-0000-0000-0000-000000000001';
const identity = { pid: 77, uid: 501, pidVersion: 12, uniqueId: '9007199254740993' };
const profile = createAppSkillProfile('12345678-1234-4234-8234-123456789abc');
const name = profile.name;
const body = ' \n中文😀 $HOME $(touch canary) `echo marker`\\\"\u2028\u2029 ';
const send: BridgeRequest = { schemaVersion: 1, operation: 'send', messageId: 'message-1', linkId: 'link-1', body };
const reply: BridgeRequest = { schemaVersion: 1, operation: 'reply', messageId: 'message-2', inReplyTo: 'original-1', body };
const connect: BridgeRequest = { schemaVersion: 1, operation: 'connect', targetSessionId: 'original-dsh' };
function payload(event: string, request: BridgeRequest = send, toolUseId = 'call-1', args = JSON.stringify(request)) {
  return { session_id: sid, transcript_path: '/synthetic/private/transcript', cwd: '/synthetic/private/cwd',
    hook_event_name: event, tool_name: 'Skill', tool_input: { skill: name, args }, tool_use_id: toolUseId,
    ...(event === 'PostToolUse' ? { tool_response: { success: true, commandName: name } } : {}) };
}

function fixture() {
  const epochs = new ClaudeSessionEpochs();
  const binding = epochs.activate(epochs.begin(identity, sid), { schemaVersion: 1, ownerPid: identity.pid,
    ownerStart: 'start', socket: '/synthetic/native.sock', endpoint: { schemaVersion: 1,
      endpointId: `claude:${sid}`, harness: 'claude-code', storageNamespace: 'a'.repeat(64),
      nativeSessionId: sid, hostInstanceId: `claude-pid:${identity.pid}`, routeGeneration: 'registered-generation' } });
  const calls: Array<Readonly<{ operation: string; input?: unknown }>> = [];
  let open = true;
  let preflight = (_request: BridgeRequest) => {};
  const receipt = (request: Exclude<BridgeRequest, { operation: 'connect' | 'list' }>, state: Receipt['state'] = 'dispatched',
    transport: Receipt['transport'] = null): Receipt => ({ messageId: request.messageId, state, transport,
    envelope: { schemaVersion: 1, messageId: request.messageId, linkId: 'linkId' in request ? request.linkId : 'reply-link',
      body: request.body, sender: binding.endpoint, replyTo: binding.endpoint,
      recipient: { ...binding.endpoint, endpointId: 'internal-dsh-endpoint', harness: 'dsh', nativeSessionId: 'original-dsh' },
      inReplyTo: 'inReplyTo' in request ? request.inReplyTo : null,
      sequence: 7, sentAt: '2026-10-14T00:00:00.000Z', source: 'peer', authority: 'none' } });
  let deliver = async (request: Exclude<BridgeRequest, { operation: 'connect' | 'list' }>) => receipt(request);
  const connection: ClaudeChannelConnection = {
    connect: async target => { calls.push({ operation: 'connect', input: target }); return 'new-link'; },
    send: request => { calls.push({ operation: 'send', input: request }); return deliver({ ...request, operation: 'send' }); },
    reply: request => { calls.push({ operation: 'reply', input: request }); return deliver({ ...request, operation: 'reply' }); },
  };
  let acquire = () => connection;
  let verifyLive = async () => {};
  const channel = createAppClaudeChannel({ assertOpen: () => { if (!open) throw new Error('PRIVATE_CLOSED_REASON'); },
    verify: async value => { await verifyLive(); epochs.verify(value, identity); },
    assertCurrent: value => { epochs.verify(value, identity); return undefined; },
    beforeDispatch: (value, request) => {
      assert.equal(value, binding); assert.equal(Object.isFrozen(request), true);
      calls.push({ operation: 'preflight' }); preflight(request);
    }, getConnection: value => {
      assert.equal(value, binding); calls.push({ operation: 'getConnection' }); return acquire();
    } }, profile);
  return { channel, binding, calls, receipt, epochs, connection, close: () => { open = false; },
    setVerifier: (callback: () => Promise<void>) => { verifyLive = callback; },
    setConnectionProvider: (callback: typeof acquire) => { acquire = callback; },
    setPreflight: (callback: typeof preflight) => { preflight = callback; },
    setDelivery: (callback: typeof deliver) => { deliver = callback; } };
}

test('Pre returns only a frozen prepared marker and makes no connection or business calls', async () => {
  const f = fixture();
  let result: unknown;
  result = await f.channel.pre(f.binding, payload('PreToolUse'));
  assert.deepEqual(result, { prepared: true });
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(f.calls, []);
});

for (const request of [connect, send, reply]) {
  test(`successful ${request.operation} Post preflights before connection and invokes business once`, async () => {
    const f = fixture(); await f.channel.pre(f.binding, payload('PreToolUse', request));
    const result = await f.channel.post(f.binding, payload('PostToolUse', request));
    assert.deepEqual(f.calls.map(call => call.operation), ['preflight', 'getConnection', request.operation]);
    if (request.operation === 'connect') assert.deepEqual(result, { linkId: 'new-link', targetSessionId: 'original-dsh' });
    else {
      assert.ok('receipt' in result);
      assert.deepEqual(result.receipt, { messageId: request.messageId, state: 'dispatched', transport: null,
        sequence: 7, linkId: request.operation === 'send' ? 'link-1' : 'reply-link', targetSessionId: 'original-dsh' });
      assert.equal(Object.isFrozen(result), true); assert.equal(Object.isFrozen(result.receipt), true);
      assert.match(result.deliveryNote, /不代表/);
      const passed = f.calls.at(-1)!.input as Record<string, unknown>;
      assert.equal(passed.body, body); assert.equal('operation' in passed, false);
      for (const text of [body, '/synthetic/private', 'internal-dsh-endpoint', 'registered-generation']) {
        assert.equal(JSON.stringify(result).includes(text), false);
      }
    }
  });
}

test('concurrent successful Posts and later identical Pre/Post reuse one pending dispatch', async () => {
  const f = fixture(); const pending = Promise.withResolvers<Receipt>();
  f.setDelivery(() => pending.promise); await f.channel.pre(f.binding, payload('PreToolUse'));
  const first = f.channel.post(f.binding, payload('PostToolUse'));
  const second = f.channel.post(f.binding, payload('PostToolUse'));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.calls.filter(call => call.operation === 'send').length, 1);
  await f.channel.pre(f.binding, payload('PreToolUse'));
  pending.resolve(f.receipt(send as Exclude<BridgeRequest, { operation: 'connect' | 'list' }>));
  assert.deepEqual(await first, await second);
  assert.deepEqual(await f.channel.post(f.binding, payload('PostToolUse')), await first);
  assert.equal(f.calls.filter(call => call.operation === 'send').length, 1);
});

test('Post without Pre cannot acquire a connection', async () => {
  const f = fixture();
  await assert.rejects(f.channel.post(f.binding, payload('PostToolUse')), /SKILL_PRE_MISSING/);
  assert.deepEqual(f.calls, []);
});

for (const stage of ['PreToolUse', 'PostToolUse']) {
  test(`changed args at ${stage} cannot overwrite the original expectation`, async () => {
    const f = fixture(); await f.channel.pre(f.binding, payload('PreToolUse'));
    const changed = { ...send, body: 'private changed body' };
    if (stage === 'PreToolUse') await assert.rejects(() => f.channel.pre(f.binding, payload(stage, changed)), /SKILL_INVOCATION_CONFLICT/);
    else await assert.rejects(f.channel.post(f.binding, payload(stage, changed)), /SKILL_INVOCATION_CONFLICT/);
    assert.equal(f.calls.length, 0);
    await f.channel.post(f.binding, payload('PostToolUse'));
    assert.equal((f.calls.at(-1)!.input as { body: string }).body, body);
  });
}

test('semantically equal but textually changed args do not match the Pre record', async () => {
  const f = fixture(); await f.channel.pre(f.binding, payload('PreToolUse'));
  await assert.rejects(f.channel.post(f.binding, payload('PostToolUse', send, 'call-1', JSON.stringify(send, null, 2))),
    /SKILL_INVOCATION_CONFLICT/);
  assert.deepEqual(f.calls, []);
});

for (const stage of ['PreToolUse', 'PostToolUse']) {
  test(`${stage} session_id is only correlation and must match authenticated native UUID`, async () => {
    const f = fixture(); const wrong = { ...payload(stage), session_id: 'forged-session' };
    if (stage === 'PreToolUse') await assert.rejects(() => f.channel.pre(f.binding, wrong), /SKILL_SOURCE_MISMATCH/);
    else { await f.channel.pre(f.binding, payload('PreToolUse')); await assert.rejects(f.channel.post(f.binding, wrong), /SKILL_SOURCE_MISMATCH/); }
    assert.deepEqual(f.calls, []);
  });
}

for (const invalidate of ['close', 'epoch'] as const) {
  for (const completed of [false, true]) {
    test(`${invalidate} rejects ${completed ? 'cached' : 'prepared'} Post before business`, async () => {
      const f = fixture(); await f.channel.pre(f.binding, payload('PreToolUse'));
      if (completed) await f.channel.post(f.binding, payload('PostToolUse'));
      const before = f.calls.length;
      if (invalidate === 'close') f.close(); else f.epochs.revoke(identity);
      await assert.rejects(() => f.channel.pre(f.binding, payload('PreToolUse')), /CLAUDE_CHANNEL_UNAVAILABLE/);
      await assert.rejects(f.channel.post(f.binding, payload('PostToolUse')), /CLAUDE_CHANNEL_UNAVAILABLE/);
      assert.equal(f.calls.length, before);
    });
  }
}

test('a changed binding with the same epoch cannot consume a trusted Pre record', async () => {
  const f = fixture(); await f.channel.pre(f.binding, payload('PreToolUse'));
  await assert.rejects(f.channel.post({ ...f.binding }, payload('PostToolUse')), /CLAUDE_CHANNEL_UNAVAILABLE/);
  assert.deepEqual(f.calls, []);
});

for (const invalid of [{ success: false, commandName: name }, { success: true, commandName: name, readOnly: true },
  { success: true, commandName: name, status: 'forked' }, { success: true, commandName: name, background: true },
  { success: true, commandName: name, permissionDecision: 'allow' }]) {
  test(`invalid native Post does not dispatch: ${JSON.stringify(invalid)}`, async () => {
    const f = fixture(); await f.channel.pre(f.binding, payload('PreToolUse'));
    await assert.rejects(f.channel.post(f.binding, { ...payload('PostToolUse'), tool_response: invalid }), /INVALID_SKILL_INVOCATION/);
    assert.deepEqual(f.calls, []);
  });
}

test('Pre/Post entry points reject swapped events and permission failures', async () => {
  const f = fixture();
  await assert.rejects(() => f.channel.pre(f.binding, payload('PostToolUse')), /INVALID_SKILL_INVOCATION/);
  await assert.rejects(f.channel.post(f.binding, payload('PreToolUse')), /INVALID_SKILL_INVOCATION/);
  await assert.rejects(f.channel.post(f.binding, payload('PostToolUseFailure')), /INVALID_SKILL_INVOCATION/);
  assert.deepEqual(f.calls, []);
});

test('capacity failure preflights the authoritative reply link and performs zero business calls', async () => {
  const f = fixture();
  f.setPreflight(request => {
    assert.equal(request.operation, 'reply');
    encodeIpcFrame({ receipt: { messageId: reply.operation === 'reply' ? reply.messageId : '',
      state: 'delivery-unknown', transport: 'written', sequence: Number.MAX_SAFE_INTEGER,
      linkId: 'x'.repeat(MAX_FRAME_BYTES), targetSessionId: 'original-dsh' }, deliveryNote: 'fixed note' });
  });
  await f.channel.pre(f.binding, payload('PreToolUse', reply));
  await assert.rejects(f.channel.post(f.binding, payload('PostToolUse', reply)), /IPC_FRAME_TOO_LARGE/);
  assert.deepEqual(f.calls.map(call => call.operation), ['preflight']);
});

test('preflight revocation is checked again before acquiring a connection', async () => {
  const f = fixture(); f.setPreflight(() => f.close());
  await f.channel.pre(f.binding, payload('PreToolUse'));
  await assert.rejects(f.channel.post(f.binding, payload('PostToolUse')), /CLAUDE_CHANNEL_UNAVAILABLE/);
  assert.deepEqual(f.calls.map(call => call.operation), ['preflight']);
});

test('a capability revoked during connection acquisition cannot invoke business', async () => {
  const f = fixture(); f.setConnectionProvider(() => { f.close(); return f.connection; });
  await f.channel.pre(f.binding, payload('PreToolUse'));
  await assert.rejects(f.channel.post(f.binding, payload('PostToolUse')), /CLAUDE_CHANNEL_UNAVAILABLE/);
  assert.deepEqual(f.calls.map(call => call.operation), ['preflight', 'getConnection']);
});

test('connection acquisition failure is sanitized and retained without a business retry', async () => {
  const f = fixture(); f.setConnectionProvider(() => { throw new Error('private socket path'); });
  await f.channel.pre(f.binding, payload('PreToolUse'));
  for (let i = 0; i < 2; i++) {
    await assert.rejects(f.channel.post(f.binding, payload('PostToolUse')), /^Error: CLAUDE_CHANNEL_DELIVERY_UNKNOWN$/);
  }
  assert.deepEqual(f.calls.map(call => call.operation), ['preflight', 'getConnection']);
});

test('a broken capacity preflight cannot truncate or expose an oversized returned result', async () => {
  const f = fixture();
  f.setConnectionProvider(() => ({ ...f.connection,
    connect: async () => { f.calls.push({ operation: 'connect' }); return 'x'.repeat(MAX_FRAME_BYTES); } }));
  await f.channel.pre(f.binding, payload('PreToolUse', connect));
  for (let i = 0; i < 2; i++) {
    await assert.rejects(f.channel.post(f.binding, payload('PostToolUse', connect)), /^Error: CLAUDE_CHANNEL_DELIVERY_UNKNOWN$/);
  }
  assert.equal(f.calls.filter(call => call.operation === 'connect').length, 1);
});

test('late closed completion cannot return a receipt into an invalidated source', async () => {
  const f = fixture(); const pending = Promise.withResolvers<Receipt>();
  f.setDelivery(() => pending.promise); await f.channel.pre(f.binding, payload('PreToolUse'));
  const result = f.channel.post(f.binding, payload('PostToolUse'));
  await new Promise<void>(resolve => setImmediate(resolve)); f.close(); pending.resolve(f.receipt(send as Exclude<BridgeRequest, { operation: 'connect' | 'list' }>));
  await assert.rejects(result, /CLAUDE_CHANNEL_UNAVAILABLE/);
  assert.equal(f.calls.filter(call => call.operation === 'send').length, 1);
});

test('business failures retain a rejected cached Promise, leak no raw data and never retry', async () => {
  const f = fixture(); f.setDelivery(async () => { throw new Error('private body and transcript path'); });
  await f.channel.pre(f.binding, payload('PreToolUse'));
  for (let i = 0; i < 2; i++) {
    await assert.rejects(f.channel.post(f.binding, payload('PostToolUse')), /^Error: CLAUDE_CHANNEL_DELIVERY_UNKNOWN$/);
  }
  assert.equal(f.calls.filter(call => call.operation === 'send').length, 1);
});

test('unknown preflight errors are sanitized without a connection', async () => {
  const f = fixture(); f.setPreflight(() => { throw new Error('private body/path'); });
  await f.channel.pre(f.binding, payload('PreToolUse'));
  await assert.rejects(f.channel.post(f.binding, payload('PostToolUse')), /^Error: CLAUDE_CHANNEL_PREFLIGHT_FAILED$/);
  assert.deepEqual(f.calls.map(call => call.operation), ['preflight']);
});

for (const transport of [null, 'written'] as const) {
  test(`unknown compact receipt ${transport} exposes no authority or body`, async () => {
    const f = fixture(); f.setDelivery(async request => f.receipt(request, 'delivery-unknown', transport));
    await f.channel.pre(f.binding, payload('PreToolUse'));
    const result = await f.channel.post(f.binding, payload('PostToolUse'));
    assert.ok('receipt' in result); assert.equal(result.receipt.state, 'delivery-unknown');
    assert.equal(result.receipt.transport, transport); assert.match(result.deliveryNote, /不要自动/);
  });
}

test('different tool calls retain original business IDs for the Router to deduplicate', async () => {
  const f = fixture();
  for (const call of ['call-1', 'call-2']) {
    await f.channel.pre(f.binding, payload('PreToolUse', send, call));
    await f.channel.post(f.binding, payload('PostToolUse', send, call));
  }
  assert.deepEqual(f.calls.filter(call => call.operation === 'send').map(call => (call.input as { messageId: string }).messageId),
    ['message-1', 'message-1']);
  assert.equal(f.calls.filter(call => call.operation === 'reply').length, 0);
});


test('live verification must settle before Pre and successful Post can proceed', async () => {
  const f = fixture(); const gate = Promise.withResolvers<void>();
  f.setVerifier(() => gate.promise);
  let settled = false;
  const prepared = f.channel.pre(f.binding, payload('PreToolUse')).then(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false); assert.deepEqual(f.calls, []);
  gate.resolve(); await prepared;
  const second = Promise.withResolvers<void>(); f.setVerifier(() => second.promise);
  const result = f.channel.post(f.binding, payload('PostToolUse'));
  await Promise.resolve(); assert.deepEqual(f.calls, []);
  second.reject(new Error('FAILED_OS_READ'));
  await assert.rejects(result, /CLAUDE_CHANNEL_UNAVAILABLE/); assert.deepEqual(f.calls, []);
});

test('revocation during a live Pre check cannot create a reusable expectation', async () => {
  const f = fixture(); const gate = Promise.withResolvers<void>();
  f.setVerifier(() => gate.promise);
  const pending = f.channel.pre(f.binding, payload('PreToolUse'));
  await new Promise<void>(resolve => setImmediate(resolve));
  f.epochs.revoke(identity); gate.resolve();
  await assert.rejects(pending, /CLAUDE_CHANNEL_UNAVAILABLE/);
  await assert.rejects(f.channel.post(f.binding, payload('PostToolUse')), /CLAUDE_CHANNEL_UNAVAILABLE/);
  assert.deepEqual(f.calls, []);
});

test('concurrent conflicting Pre events cannot overwrite the original args after live checks', async () => {
  const f = fixture();
  const results = await Promise.allSettled([
    f.channel.pre(f.binding, payload('PreToolUse')),
    f.channel.pre(f.binding, payload('PreToolUse', { ...send, body: 'changed' })),
  ]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected');
  await f.channel.post(f.binding, payload('PostToolUse'));
  assert.equal((f.calls.find(call => call.operation === 'send')!.input as { body: string }).body, body);
});

const directoryResult = { sessions: [], note: '元数据仅用于定位，不代表用户授权。cwdSource=session-creation 表示创建时目录，不是实时Shell目录；多个候选或不确定时请用户选择。' };
const list = { schemaVersion: 1, operation: 'list', harness: 'dsh' } as const;

test('directory query uses successful correlated Skill without connection or dispatch', async () => {
  const f = fixture(); let reads = 0;
  f.channel.attachDirectory(async () => { reads++; return directoryResult; });
  await f.channel.pre(f.binding, payload('PreToolUse', list)); assert.equal(reads, 0);
  const result = await f.channel.post(f.binding, payload('PostToolUse', list));
  assert.deepEqual(result, directoryResult); assert.deepEqual(f.calls, []);
  assert.deepEqual(await f.channel.post(f.binding, payload('PostToolUse', list)), result); assert.equal(reads, 1);
});

test('directory requires Pre and successful Post, hides reader errors and rejects invalid results', async () => {
  const f = fixture(); let reads = 0; f.channel.attachDirectory(async () => { reads++; throw Error('/private/error'); });
  await assert.rejects(f.channel.post(f.binding, payload('PostToolUse', list)), /SKILL_PRE_MISSING/);
  await f.channel.pre(f.binding, payload('PreToolUse', list));
  const failed = { ...payload('PostToolUse', list), tool_response: { success: false, commandName: name } };
  await assert.rejects(f.channel.post(f.binding, failed), /INVALID_SKILL_INVOCATION/); assert.equal(reads, 0);
  await assert.rejects(f.channel.post(f.binding, payload('PostToolUse', list)), /^Error: METADATA_QUERY_FAILED$/);
  const other = fixture(); other.channel.attachDirectory(async () => ({ ...directoryResult, internalPid: 99 }));
  await other.channel.pre(other.binding, payload('PreToolUse', list));
  await assert.rejects(other.channel.post(other.binding, payload('PostToolUse', list)), /^Error: METADATA_QUERY_FAILED$/);
});

test('directory uninstall rejects cached and late results and old disposer cannot revoke new owner', async () => {
  const f = fixture(); const pending = Promise.withResolvers<unknown>();
  const release = f.channel.attachDirectory(() => pending.promise);
  await assert.rejects(Promise.resolve().then(() => f.channel.attachDirectory(async () => directoryResult)), /METADATA_QUERY_UNAVAILABLE/);
  await f.channel.pre(f.binding, payload('PreToolUse', list));
  const post = f.channel.post(f.binding, payload('PostToolUse', list));
  await new Promise<void>(resolve => setImmediate(resolve)); release();
  pending.resolve(directoryResult); await assert.rejects(post, /METADATA_QUERY_UNAVAILABLE/);
  f.channel.attachDirectory(async () => directoryResult); release();
  await assert.rejects(f.channel.post(f.binding, payload('PostToolUse', list)), /METADATA_QUERY_UNAVAILABLE/);
  await f.channel.pre(f.binding, payload('PreToolUse', list, 'new-call'));
  assert.deepEqual(await f.channel.post(f.binding, payload('PostToolUse', list, 'new-call')), directoryResult);
});

test('directory absence and identity revocation during read never return metadata', async () => {
  const f = fixture(); await f.channel.pre(f.binding, payload('PreToolUse', list));
  await assert.rejects(f.channel.post(f.binding, payload('PostToolUse', list)), /METADATA_QUERY_UNAVAILABLE/);
  const other = fixture(); const pending = Promise.withResolvers<unknown>(); other.channel.attachDirectory(() => pending.promise);
  await other.channel.pre(other.binding, payload('PreToolUse', list));
  const post = other.channel.post(other.binding, payload('PostToolUse', list));
  await new Promise<void>(resolve => setImmediate(resolve)); other.epochs.revoke(identity);
  pending.resolve(directoryResult); await assert.rejects(post, /CLAUDE_CHANNEL_UNAVAILABLE/);
});

test('directory replacement during deferred authentication cannot use the new provider under old Pre', async () => {
  const f = fixture(); let oldReads = 0; let newReads = 0;
  const release = f.channel.attachDirectory(async () => { oldReads++; return directoryResult; });
  await f.channel.pre(f.binding, payload('PreToolUse', list));
  const gate = Promise.withResolvers<void>(); let entered = false;
  f.setVerifier(async () => { if (!entered) { entered = true; return; } await gate.promise; });
  const post = f.channel.post(f.binding, payload('PostToolUse', list));
  await new Promise<void>(resolve => setImmediate(resolve)); release();
  f.channel.attachDirectory(async () => { newReads++; return directoryResult; });
  gate.resolve(); await assert.rejects(post, /METADATA_QUERY_UNAVAILABLE/);
  assert.equal(oldReads, 0); assert.equal(newReads, 0);
});

test('directory nested hook overflow rejects rather than truncating or dispatching', async () => {
  const f = fixture(); f.channel.attachDirectory(async () => ({ ...directoryResult, sessions: [{
    harness: 'dsh', sessionId: 'original-dsh', metadataRevision: 1, title: '"'.repeat(350000),
    titleProvider: 'host', workspacePath: null, cwd: null, cwdSource: 'unknown', worktreePath: null, clientSurface: 'desktop',
  }] }));
  await f.channel.pre(f.binding, payload('PreToolUse', list));
  await assert.rejects(f.channel.post(f.binding, payload('PostToolUse', list)), /IPC_FRAME_TOO_LARGE/);
  assert.deepEqual(f.calls, []);
});

for (const stage of [2, 3]) {
  test(`directory revocation between ready settlement and ${stage === 2 ? 'read' : 'return'} rejects`, async () => {
    const f = fixture(); let reads = 0;
    f.channel.attachDirectory(async () => { reads++; return directoryResult; });
    await f.channel.pre(f.binding, payload('PreToolUse', list));
    let checks = 0;
    f.setVerifier(async () => {
      if (++checks === stage) queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => f.epochs.revoke(identity))));
    });
    await assert.rejects(f.channel.post(f.binding, payload('PostToolUse', list)), /CLAUDE_CHANNEL_UNAVAILABLE/);
    assert.equal(reads, stage === 2 ? 0 : 1);
  });
}

function sizedDirectory(units: number, prefix: string) {
  const base = { ...directoryResult, sessions: [{
    harness: 'dsh', sessionId: 'original-dsh', metadataRevision: 1, title: prefix,
    titleProvider: 'host', workspacePath: null, cwd: null, cwdSource: 'unknown', worktreePath: null, clientSurface: 'desktop',
  }] };
  const title = prefix + 'x'.repeat(units - JSON.stringify(base).length);
  return { ...base, sessions: [{ ...base.sessions[0]!, title }] };
}

for (const prefix of ['', '😀'.repeat(2000), '\n"\\']) {
  test(`Claude directory counts whole serialized UTF-16 JSON including ${prefix.length} prefix units`, async () => {
    for (const units of [10000, 10001]) {
      const result = sizedDirectory(units, prefix); const original = JSON.stringify(result);
      assert.equal(original.length, units);
      const f = fixture(); let reads = 0;
      f.channel.attachDirectory(async () => { reads++; return result; });
      await f.channel.pre(f.binding, payload('PreToolUse', list));
      if (units === 10000) assert.deepEqual(await f.channel.post(f.binding, payload('PostToolUse', list)), result);
      else {
        await assert.rejects(f.channel.post(f.binding, payload('PostToolUse', list)), /^Error: METADATA_CONTEXT_TOO_LARGE$/);
        await assert.rejects(f.channel.post(f.binding, payload('PostToolUse', list)), /^Error: METADATA_CONTEXT_TOO_LARGE$/);
      }
      assert.equal(reads, 1); assert.deepEqual(f.calls, []); assert.equal(JSON.stringify(result), original);
    }
  });
}

test('directory budget includes every row while normal long messages retain their original body', async () => {
  const row = sizedDirectory(6000, '').sessions[0]!;
  const result = { ...directoryResult, sessions: [row, { ...row, sessionId: 'second-original' }] };
  assert.ok(JSON.stringify(result).length > 10000);
  const f = fixture(); f.channel.attachDirectory(async () => result);
  await f.channel.pre(f.binding, payload('PreToolUse', list));
  await assert.rejects(f.channel.post(f.binding, payload('PostToolUse', list)), /^Error: METADATA_CONTEXT_TOO_LARGE$/);
  assert.deepEqual(f.calls, []);
  const normal = fixture(); const request = { ...send, body: '😀'.repeat(6000) };
  await normal.channel.pre(normal.binding, payload('PreToolUse', request, 'normal-message'));
  const receipt = await normal.channel.post(normal.binding, payload('PostToolUse', request, 'normal-message'));
  assert.ok('receipt' in receipt);
  assert.equal((normal.calls.at(-1)!.input as { body: string }).body, request.body);
});
