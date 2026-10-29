// INPUT: Synthetic live kernel reads, native lifecycle/Skill events and bound original actors.
// OUTPUT: Lifecycle-gated single-Router communication and fail-closed integration regressions.
// POS: Offline runtime assembly; no real helper, native SDK or model communication proof.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSessionRuntime } from '../../src/bridge/session-runtime.ts';
import { type ProcessSnapshot } from '../../src/adapters/claude/peer-identity.ts';
import { type StdioRequest } from '../../src/bridge/stdio-rpc.ts';
import { type Envelope } from '../../src/protocol/message.ts';

const sid = '00000000-0000-0000-0000-000000000001';
const pin = { path: '/synthetic/2.1.295', sha256: 'a'.repeat(64) };
const cli: ProcessSnapshot = { pid: 77, uid: 501, pidVersion: 12, uniqueId: '777',
  parentPid: 1, parentUniqueId: '1', exe: pin.path, sha256: pin.sha256 };
const helper: ProcessSnapshot = { ...cli, pid: 99, pidVersion: 13, uniqueId: '999',
  parentPid: cli.pid, parentUniqueId: cli.uniqueId, exe: '/synthetic/python' };
const lifecycle = (event: string, extra = {}) => ({ hook_event_name: event, session_id: sid,
  transcript_path: '/synthetic/transcript', cwd: '/synthetic/workspace', permission_mode: 'default',
  ...(event === 'SessionStart' ? { source: 'startup' } : { reason: 'prompt_input_exit' }), ...extra });
const skill = (event: string, args: object, callId = 'call-1') => ({ hook_event_name: event,
  session_id: sid, transcript_path: '/synthetic/transcript', cwd: '/synthetic/workspace',
  tool_name: 'Skill', tool_use_id: callId,
  tool_input: { skill: 'agent-message-switchboard:message', args: JSON.stringify(args) },
  ...(event === 'PostToolUse' ? { tool_response: { success: true, commandName: 'agent-message-switchboard:message' } } : {}) });
function request(payload: unknown): StdioRequest {
  return { schemaVersion: 1, requestId: '00000000-0000-0000-0000-000000000099',
    peer: { pid: helper.pid, uid: helper.uid, pidVersion: helper.pidVersion },
    snapshots: [[helper], [helper]], payload };
}
function fixture() {
  const actor = { id: 'original-dsh', ctx: {}, session: { header: { id: 'original-dsh', cwd: '/synthetic/dsh-creation' } } };
  const dshFrames: Envelope[] = []; const cliFrames: Envelope[] = [];
  let currentCli = cli; let routes = 0; let reads = 0;
  let currentDsh: unknown = actor; let lookupDsh = (id: string): unknown => id === actor.id ? currentDsh : undefined; let inspectGate = async (_pid: number) => {};
  let routeGate = async () => {};
  const runtime = createSessionRuntime({ host: { surface: 'desktop', version: '0.2.0-rc.2',
    storageNamespace: 'b'.repeat(64), hostInstanceId: 'fixed-host', routeGeneration: 'fixed-generation',
    getAgent: id => lookupDsh(id), isArchived: () => false },
    inspect: async pid => { reads++; await inspectGate(pid); return pid === helper.pid ? helper : pid === cli.pid ? currentCli : null; },
    classify: value => value.exe === pin.path ? 'cli' : value.exe === helper.exe ? 'wrapper' : 'unsupported', cliPin: pin,
    assertOpen() {}, guardDispatch() {},
    async getRoute(identity, id) { routes++; await routeGate(); return { schemaVersion: 1, ownerPid: identity.pid,
      ownerStart: 'synthetic-start', socket: '/synthetic/native.sock', endpoint: { schemaVersion: 1,
        endpointId: `claude:${id}`, harness: 'claude-code', nativeSessionId: id,
        storageNamespace: 'c'.repeat(64), hostInstanceId: `claude-pid:${identity.pid}`, routeGeneration: 'original' } }; },
    makeDshPush: () => frame => { dshFrames.push(frame); return { state: 'dispatched', transport: null }; },
    makeClaudePush: () => frame => { cliFrames.push(frame); return { state: 'delivery-unknown', transport: 'written' }; },
  });
  const source = runtime.registerDsh({ agent: actor });
  async function call(args: object, callId: string) {
    await runtime.handle(request(skill('PreToolUse', args, callId)));
    return runtime.handle(request(skill('PostToolUse', args, callId)));
  }
  return { runtime, source, actor, call, dshFrames, cliFrames, routes: () => routes, reads: () => reads,
    setCli: (row: ProcessSnapshot) => { currentCli = row; },
    setDsh: (value: unknown) => { currentDsh = value; },
    setDshLookup: (read: (id: string) => unknown) => { lookupDsh = read; },
    setInspectGate: (value: (pid: number) => Promise<void>) => { inspectGate = value; },
    setRouteGate: (gate: () => Promise<void>) => { routeGate = gate; } };
}

test('first authenticated startup enables either-side connect and three original-address rounds', async () => {
  const f = fixture();
  assert.deepEqual(await f.runtime.handle(request(lifecycle('SessionStart'))), { prepared: true });
  const linkId = await f.source.connect(sid);
  assert.deepEqual(await f.call({ schemaVersion: 1, operation: 'connect', targetSessionId: f.actor.id }, 'connect'),
    { linkId, targetSessionId: f.actor.id });
  for (let round = 1; round <= 3; round++) {
    const messageId = `dsh-${round}`;
    await f.source.send({ schemaVersion: 1, messageId, linkId, body: `raw ${round}\n😀` });
    const result = await f.call({ schemaVersion: 1, operation: 'reply', messageId: `claude-${round}`,
      inReplyTo: messageId, body: `answer ${round}` }, `reply-${round}`);
    assert.ok('receipt' in result); assert.equal(result.receipt.state, 'dispatched');
    assert.equal(f.cliFrames[round - 1].recipient.nativeSessionId, sid);
    assert.equal(f.dshFrames[round - 1].recipient.nativeSessionId, f.actor.id);
    assert.equal(f.dshFrames[round - 1].inReplyTo, messageId);
  }
  assert.equal(f.routes(), 1); assert.ok(f.reads() > 6);
});

test('Skill before startup and unsupported lifecycle do not create routes or dispatch', async () => {
  const f = fixture();
  await assert.rejects(f.call({ schemaVersion: 1, operation: 'connect', targetSessionId: f.actor.id }, 'early'), /UNREGISTERED_CLAUDE_SESSION/);
  await assert.rejects(f.runtime.handle(request(lifecycle('OtherEvent'))), /INVALID_HOOK_EVENT/);
  assert.equal(f.routes(), 0); assert.equal(f.dshFrames.length, 0);
});

for (const extra of [{}, { session_id: 'bad' }, { source: 'resume' }]) {
  test(`observed second startup revokes original binding even when invalid: ${JSON.stringify(extra)}`, async () => {
    const f = fixture(); await f.runtime.handle(request(lifecycle('SessionStart')));
    const linkId = await f.source.connect(sid);
    await assert.rejects(f.runtime.handle(request(lifecycle('SessionStart', extra))));
    await assert.rejects(f.source.send({ schemaVersion: 1, messageId: 'late', linkId, body: 'body' }), /SESSION_EPOCH_REVOKED/);
    assert.equal(f.cliFrames.length, 0); assert.equal(f.routes(), 1);
  });
}

test('End revokes old links and cached message replay, not just new sends', async () => {
  const f = fixture(); await f.runtime.handle(request(lifecycle('SessionStart')));
  const linkId = await f.source.connect(sid);
  const args = { schemaVersion: 1 as const, messageId: 'first', linkId, body: 'body' };
  await f.source.send(args); await f.runtime.handle(request(lifecycle('SessionEnd')));
  await assert.rejects(f.source.send(args), /SESSION_EPOCH_REVOKED/);
  assert.equal(f.cliFrames.length, 1);
});

test('an End during asynchronous route creation defeats late first activation', async () => {
  const f = fixture(); const gate = Promise.withResolvers<void>();
  f.setRouteGate(() => gate.promise);
  const start = f.runtime.handle(request(lifecycle('SessionStart')));
  await new Promise<void>(resolve => setImmediate(resolve));
  await f.runtime.handle(request(lifecycle('SessionEnd'))); gate.resolve();
  await assert.rejects(start, /SESSION_EPOCH_REVOKED/);
  await assert.rejects(f.source.connect(sid), /UNKNOWN_TARGET/);
});

test('route failure is irreversible and no later startup silently repairs the epoch', async () => {
  const f = fixture(); f.setRouteGate(async () => { throw new Error('synthetic-route-failure'); });
  await assert.rejects(f.runtime.handle(request(lifecycle('SessionStart'))), /synthetic-route-failure/);
  await assert.rejects(f.runtime.handle(request(lifecycle('SessionStart'))), /SESSION_EPOCH_REVOKED/);
  assert.equal(f.routes(), 1);
});

test('fresh kernel identity changes invalidate the old recipient before another push', async () => {
  const f = fixture(); await f.runtime.handle(request(lifecycle('SessionStart')));
  const linkId = await f.source.connect(sid);
  f.setCli({ ...cli, uniqueId: 'changed-generation' });
  await assert.rejects(f.source.send({ schemaVersion: 1, messageId: 'changed', linkId, body: '' }));
  assert.equal(f.cliFrames.length, 0);
});

test('runtime closure admits no new registration, Skill event or cached link', async () => {
  const f = fixture(); await f.runtime.handle(request(lifecycle('SessionStart')));
  const linkId = await f.source.connect(sid); f.runtime.close();
  await assert.rejects(f.source.connect(sid), /SESSION_RUNTIME_CLOSED/);
  await assert.rejects(f.runtime.handle(request(lifecycle('SessionEnd'))), /SESSION_RUNTIME_CLOSED/);
  assert.throws(() => f.runtime.registerDsh({ agent: f.actor }), /SESSION_RUNTIME_CLOSED/);
  assert.equal(f.cliFrames.length, 0);
});

test('request snapshots never substitute for fresh kernel reads', async () => {
  const f = fixture(); f.setCli({ ...cli, sha256: 'b'.repeat(64) });
  await assert.rejects(f.runtime.handle(request(lifecycle('SessionStart'))), /UNSUPPORTED_CLAUDE_BINARY/);
  assert.equal(f.routes(), 0);
});
for(const metadata of [{scratchpad_dir:'/synthetic/scratch'}, {session_title:'synthetic auto or custom title'},
 {scratchpad_dir:'/synthetic/scratch',session_title:'synthetic renamed title'}]) {
 test('fixed official lifecycle string metadata enables registration without changing identity: '+Object.keys(metadata).join(','),async()=>{
  const f=fixture();assert.deepEqual(await f.runtime.handle(request(lifecycle('SessionStart',metadata))),{prepared:true});
  assert.equal(f.routes(),1);assert.ok(await f.source.connect(sid));assert.equal(f.cliFrames.length,0);
 });
}
for(const metadata of [{scratchpad_dir:null},{scratchpad_dir:{}},{session_title:[]},{session_title:42},{unknown_field:'synthetic'}]){
 test('malformed or unknown lifecycle metadata rejects before route creation: '+JSON.stringify(metadata),async()=>{
  const f=fixture();await assert.rejects(f.runtime.handle(request(lifecycle('SessionStart',metadata))),/INVALID_LIFECYCLE_EVENT/);
  assert.equal(f.routes(),0);assert.equal(f.cliFrames.length,0);
 });
}

test('trusted descriptors filter platform before live reads and expose only immutable endpoint plus creation cwd', async () => {
  const f = fixture(); await f.runtime.handle(request(lifecycle('SessionStart')));
  const before = f.reads(); const dsh = await f.runtime.describe('dsh');
  assert.equal(f.reads(), before); assert.deepEqual(dsh, [{ endpoint: f.source.endpoint, cwd: '/synthetic/dsh-creation' }]);
  const claude = await f.runtime.describe('claude-code'); assert.ok(f.reads() > before);
  assert.equal(claude.length, 1); assert.equal(claude[0].endpoint.nativeSessionId, sid);
  assert.equal(claude[0].cwd, '/synthetic/workspace'); assert.deepEqual(Object.keys(claude[0]).sort(), ['cwd', 'endpoint']);
  assert.ok(Object.isFrozen(claude)); assert.ok(Object.isFrozen(claude[0])); assert.ok(Object.isFrozen(claude[0].endpoint));
  const readCount = f.reads(); assert.deepEqual(await f.runtime.describe('codex'), []); assert.equal(f.reads(), readCount);
  await f.runtime.verifyEndpoint(f.source.endpoint); await f.runtime.verifyEndpoint(claude[0].endpoint);
});

test('descriptor cwd stays the first SessionStart creation value after later Skill events', async () => {
  const f = fixture(); await f.runtime.handle(request(lifecycle('SessionStart', { cwd: '/synthetic/creation' })));
  const value = skill('PreToolUse', { schemaVersion: 1, operation: 'connect', targetSessionId: f.actor.id });
  await f.runtime.handle(request({ ...value, cwd: '/synthetic/later-context' }));
  assert.equal((await f.runtime.describe('claude-code'))[0].cwd, '/synthetic/creation');
  assert.equal(f.cliFrames.length, 0); assert.equal(f.dshFrames.length, 0);
});

test('trusted endpoint verification rejects unknown or forged full identity without kernel reads', async () => {
  const f = fixture(); const before = f.reads();
  for (const patch of [{ endpointId: 'unknown' }, { routeGeneration: 'forged' }, { nativeSessionId: 'other' },
    { hostInstanceId: 'forged' }, { storageNamespace: 'other' }, { harness: 'claude-code' as const }]) {
    await assert.rejects(f.runtime.verifyEndpoint({ ...f.source.endpoint, ...patch }), /UNKNOWN_RUNTIME_ENDPOINT|RUNTIME_ENDPOINT_CHANGED/);
  }
  assert.equal(f.reads(), before);
  await assert.rejects(f.runtime.verifyEndpoint({ ...f.source.endpoint, extra: 'forged' } as never), /INVALID_FIELDS/);
});

test('End and repeated Start revoke descriptor reads and endpoint verification', async () => {
  for (const event of ['SessionEnd', 'SessionStart']) {
    const f = fixture(); await f.runtime.handle(request(lifecycle('SessionStart')));
    const [{ endpoint }] = await f.runtime.describe('claude-code');
    if (event === 'SessionStart') await assert.rejects(f.runtime.handle(request(lifecycle(event))), /SESSION_EPOCH_REVOKED/);
    else await f.runtime.handle(request(lifecycle(event)));
    await assert.rejects(f.runtime.verifyEndpoint(endpoint), /SESSION_EPOCH_REVOKED/);
    await assert.rejects(f.runtime.describe('claude-code'), /SESSION_EPOCH_REVOKED/);
  }
});

test('descriptor awaiting fresh kernel reads rejects a concurrent End', async () => {
  const f = fixture(); await f.runtime.handle(request(lifecycle('SessionStart')));
  const gate = Promise.withResolvers<void>(); let blocked = false;
  f.setInspectGate(async () => { if (!blocked) { blocked = true; await gate.promise; } });
  const described = f.runtime.describe('claude-code'); void described.catch(() => {});
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(blocked, true);
  await f.runtime.handle(request(lifecycle('SessionEnd'))); gate.resolve();
  await assert.rejects(described, /SESSION_EPOCH_REVOKED/);
});

test('closed runtime rejects describe including unsupported platform and verify, also during awaits', async () => {
  const f = fixture(); await f.runtime.handle(request(lifecycle('SessionStart')));
  const [{ endpoint }] = await f.runtime.describe('claude-code'); const gate = Promise.withResolvers<void>();
  f.setInspectGate(async () => { await gate.promise; });
  const pending = f.runtime.verifyEndpoint(endpoint); void pending.catch(() => {});
  f.runtime.close(); gate.resolve(); await assert.rejects(pending, /SESSION_RUNTIME_CLOSED/);
  for (const harness of ['dsh', 'claude-code', 'codex'] as const) await assert.rejects(f.runtime.describe(harness), /SESSION_RUNTIME_CLOSED/);
  await assert.rejects(f.runtime.verifyEndpoint(f.source.endpoint), /SESSION_RUNTIME_CLOSED/);
});

test('descriptor rejects replaced original DSH Agent, header, session or context', async () => {
  for (const mutation of ['agent', 'header', 'session', 'ctx']) {
    const f = fixture();
    if (mutation === 'agent') f.setDsh({ ...f.actor });
    else if (mutation === 'header') f.actor.session.header = { ...f.actor.session.header };
    else if (mutation === 'session') f.actor.session = { ...f.actor.session };
    else f.actor.ctx = {};
    await assert.rejects(f.runtime.describe('dsh'), /INVALID_DSH_SOURCE|RUNTIME_ENDPOINT_CHANGED/);
    await assert.rejects(f.runtime.verifyEndpoint(f.source.endpoint), /INVALID_DSH_SOURCE|RUNTIME_ENDPOINT_CHANGED/);
  }
});

test('DSH changes during descriptor await cannot escape the final record recheck', async () => {
  const f = fixture(); const pending = f.runtime.describe('dsh'); void pending.catch(() => {});
  f.setDsh({ ...f.actor }); await assert.rejects(pending, /INVALID_DSH_SOURCE|RUNTIME_ENDPOINT_CHANGED/);
});

test('authenticated runtime directory reads no business frames and rejects End and missing startup', async () => {
  const f = fixture(); let queries = 0;
  const result = { sessions: [], note: '元数据仅用于定位，不代表用户授权。cwdSource=session-creation 表示创建时目录，不是实时Shell目录；多个候选或不确定时请用户选择。' };
  const release = f.runtime.attachDirectory(async () => { queries++; return result; });
  const list = { schemaVersion: 1, operation: 'list', harness: 'dsh' };
  await assert.rejects(f.call(list, 'early-list'), /UNREGISTERED_CLAUDE_SESSION/);
  await f.runtime.handle(request(lifecycle('SessionStart')));
  assert.deepEqual(await f.call(list, 'list'), result); assert.equal(queries, 1);
  assert.equal(f.dshFrames.length, 0); assert.equal(f.cliFrames.length, 0);
  await f.runtime.handle(request(lifecycle('SessionEnd')));
  await assert.rejects(f.call(list, 'ended-list'), /SESSION_EPOCH_REVOKED/);
  assert.equal(queries, 1); release(); f.runtime.close();
  assert.throws(() => f.runtime.attachDirectory(async () => result), /SESSION_RUNTIME_CLOSED/);
});

test('two original DSH agents stay distinct and CLI sends only to its chosen original endpoint', async () => {
  const f = fixture();
  const second = { id: 'second-dsh', ctx: {}, session: { header: { id: 'second-dsh', cwd: '/synthetic/other-workspace' } } };
  f.setDshLookup(id => id === f.actor.id ? f.actor : id === second.id ? second : undefined);
  const b = f.runtime.registerDsh({ agent: second });
  await f.runtime.handle(request(lifecycle('SessionStart')));
  const entries = await f.runtime.describe('dsh');
  assert.equal(entries.length, 2); assert.deepEqual(entries.map(row => row.cwd), ['/synthetic/dsh-creation', '/synthetic/other-workspace']);
  assert.throws(() => f.runtime.registerDsh({ agent: { ...second } }), /INVALID_DSH_SOURCE/);
  const connected = await f.call({ schemaVersion: 1, operation: 'connect', targetSessionId: second.id }, 'choose-b');
  assert.ok('linkId' in connected);
  for (let n = 1; n <= 3; n++) {
    await f.call({ schemaVersion: 1, operation: 'send', messageId: `c${n}`, linkId: connected.linkId, body: `C${n}` }, `send-${n}`);
    await b.reply({ schemaVersion: 1, messageId: `r${n}`, inReplyTo: `c${n}`, body: `R${n}` });
  }
  assert.equal(f.dshFrames.filter(frame => frame.recipient.nativeSessionId === f.actor.id).length, 0);
  assert.equal(f.dshFrames.filter(frame => frame.recipient.nativeSessionId === second.id).length, 3);
  assert.equal(f.cliFrames.length, 3);
  f.setDshLookup(id => id === f.actor.id ? f.actor : undefined);
  await assert.rejects(f.runtime.describe('dsh'), /INVALID_DSH_SOURCE/);
});
