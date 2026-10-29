// INPUT: Synthetic authenticated CLI/App chains and real temporary local socket fixtures.
// OUTPUT: Pending visibility, original Start activation and irreversible revocation checks.
// POS: Offline App runtime integration without real App, DSH or model execution.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createAppSessionRuntime } from '../../src/bridge/app-session-runtime.ts';
import { createAppSkillProfile } from '../../src/bridge/skill-request.ts';
import { type Envelope } from '../../src/protocol/message.ts';
import { type ProcessSnapshot } from '../../src/adapters/claude/peer-identity.ts';
const sid = '12345678-1234-4234-8234-123456789abc';
const cliPin = { path: '/cli', sha256: 'a'.repeat(64) };
const appPin = { path: '/app', sha256: 'b'.repeat(64) };
const app: ProcessSnapshot = { pid: 30, uid: 501, pidVersion: 1, uniqueId: '30', parentPid: 1, parentUniqueId: '1', exe: appPin.path, sha256: appPin.sha256 };
const cli: ProcessSnapshot = { ...app, pid: 40, uniqueId: '40', parentPid: 30, parentUniqueId: '30', exe: cliPin.path, sha256: cliPin.sha256 };
const otherCli = { ...cli, pid: 50, uniqueId: '50' };
const terminal = { ...app, pid: 70, uniqueId: '70', exe: '/terminal' };
const terminalCli = { ...cli, pid: 60, uniqueId: '60', parentPid: 70, parentUniqueId: '70' };
async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'app-runtime-')); chmodSync(dir, 0o700);
  const path = join(dir, 'socket'); const server = createServer(); const servers = [server];
  await new Promise<void>(resolve => server.listen(path, resolve)); chmodSync(path, 0o600);
  t.after(async () => { for (const owned of servers.toReversed()) await new Promise<void>(resolve => owned.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); });
  const dshFrames: Envelope[] = []; const appFrames: Envelope[] = []; const pushReads: number[] = [];
  let currentApp = app; let routes = 0; let reads = 0;
  let inspectGate = async (_read: number) => {};
  let routeGate = async () => {};
  const actor = { id: 'dsh', ctx: {}, session: { header: { id: 'dsh' } } };
  const runtime = createAppSessionRuntime({ runId: sid, appPin, appHelperPins: [], cliPin,
    host: { surface: 'desktop', version: '0.2.0-rc.2', storageNamespace: 'c'.repeat(64), hostInstanceId: 'host', routeGeneration: 'generation', getAgent: id => id === actor.id ? actor : undefined, isArchived: () => false },
    inspect: async pid => { await inspectGate(++reads); return pid === cli.pid ? cli : pid === app.pid ? currentApp : pid === otherCli.pid ? otherCli : pid === terminalCli.pid ? terminalCli : pid === terminal.pid ? terminal : null; },
    classify: row => row.exe === cliPin.path ? 'cli' : 'unsupported', assertOpen() {}, guardDispatch() {},
    async getRoute(identity, id, socket) { routes++; await routeGate(); return { schemaVersion: 1, ownerPid: identity.pid, ownerStart: 'start', socket: socket.path,
      endpoint: { schemaVersion: 1, endpointId: `claude:${id}`, harness: 'claude-code', nativeSessionId: id, storageNamespace: 'd'.repeat(64), hostInstanceId: `claude-pid:${identity.pid}`, routeGeneration: 'route' } }; },
    makeDshPush: () => frame => { dshFrames.push(frame); pushReads.push(reads); return { state: 'dispatched', transport: null }; },
    makeClaudePush: () => frame => { appFrames.push(frame); pushReads.push(reads); return { state: 'delivery-unknown', transport: 'written' }; },
  }, createAppSkillProfile(sid));
  const request = (event = 'SessionStart', nativeSid = sid) => ({ schemaVersion: 1 as const, requestId: sid, peer: cli, snapshots: [],
    payload: { profile: 'app-code', startup: event === 'SessionStart' ? { socketPath: path } : null,
      hook: { hook_event_name: event, session_id: nativeSid, transcript_path: '/t', cwd: '/w', ...(event === 'SessionStart' ? { source: 'startup' } : { reason: 'exit' }) } } });
  const confirm = (candidate: Awaited<typeof runtime.whenCandidate>) => ({ schemaVersion: 1, action: 'activate-app', runId: sid, candidateId: candidate.candidateId,
    source: 'app-status-copy-all', nativeSessionId: sid, desktopSessionId: `local_${sid}`, identityFingerprint: candidate.identityFingerprint, statusReportSha256: 'e'.repeat(64) });
  const skill = (event: string, args: object, callId: string) => ({ ...request(), payload: { profile: 'app-code', startup: null,
    hook: { hook_event_name: event, session_id: sid, transcript_path: '/t', cwd: '/w', tool_name: 'Skill', tool_use_id: callId,
      tool_input: { skill: `ms-app-message-${sid.slice(0, 8)}`, args: JSON.stringify(args) },
      ...(event === 'PostToolUse' ? { tool_response: { success: true, commandName: `ms-app-message-${sid.slice(0, 8)}`, readOnly: false, status: 'inline' } } : {}) } } });
  const call = async (args: object, callId: string) => {
    await runtime.handle(skill('PreToolUse', args, callId)); return runtime.handle(skill('PostToolUse', args, callId));
  };
  const replaceSocket = async () => {
    rmSync(path); const replacement = createServer(); servers.push(replacement);
    await new Promise<void>(resolve => replacement.listen(path, resolve)); chmodSync(path, 0o600);
  };
  return { runtime, request, confirm, actor, path, call, dshFrames, appFrames, pushReads, replaceSocket, reads: () => reads,
    setInspectGate: (gate: (read: number) => Promise<void>) => { inspectGate = gate; },
    setRouteGate: (gate: () => Promise<void>) => { routeGate = gate; }, routes: () => routes, changeApp: () => { currentApp = { ...app, pidVersion: 2 }; } };
}
test('pending has no directory and activation completes exactly one original Start', async t => {
  const f = await fixture(t); await f.runtime.handle(f.request());
  const candidate = await f.runtime.whenCandidate;
  assert.deepEqual(await f.runtime.describe('claude-code'), []); assert.equal(f.routes(), 0);
  await f.runtime.activate(candidate.candidateId, f.confirm(candidate));
  assert.equal(f.routes(), 1); assert.equal((await f.runtime.describe('claude-code')).length, 1);
  f.runtime.close();
});
test('authenticated second Start and End revoke pending admission', async t => {
  for (const event of ['SessionStart', 'SessionEnd']) {
    const f = await fixture(t); await f.runtime.handle(f.request()); const candidate = await f.runtime.whenCandidate;
    if (event === 'SessionStart') await assert.rejects(f.runtime.handle(f.request(event)));
    else assert.deepEqual(await f.runtime.handle(f.request(event)), { prepared: true });
    await assert.rejects(f.runtime.activate(candidate.candidateId, f.confirm(candidate))); assert.equal(f.routes(), 0);
  }
});
test('changed App generation before activation closes run', async t => {
  const f = await fixture(t); await f.runtime.handle(f.request()); const candidate = await f.runtime.whenCandidate;
  f.changeApp(); await assert.rejects(f.runtime.activate(candidate.candidateId, f.confirm(candidate))); assert.equal(f.routes(), 0);
});

test('pending DSH connection cannot connect, send or reply', async t => {
  const f = await fixture(t); const source = f.runtime.registerDsh({ agent: f.actor });
  await f.runtime.handle(f.request());
  await assert.rejects(source.connect(sid)); await assert.rejects(source.send({})); await assert.rejects(source.reply({}));
  assert.deepEqual(await f.runtime.describe('dsh'), []);
  f.runtime.close();
});
test('End, second Start and stop defeat every activation kernel-read await', async t => {
  const baseline = await fixture(t); await baseline.runtime.handle(baseline.request());
  const candidate = await baseline.runtime.whenCandidate; const before = baseline.reads();
  await baseline.runtime.activate(candidate.candidateId, baseline.confirm(candidate));
  const activationReads = baseline.reads() - before; baseline.runtime.close();
  for (const event of ['SessionEnd', 'SessionStart', 'stop']) {
    for (let index = 1; index <= activationReads; index++) {
      const f = await fixture(t); await f.runtime.handle(f.request()); const pending = await f.runtime.whenCandidate;
      const target = f.reads() + index;
      let entered!: () => void; let release!: () => void;
      const reached = new Promise<void>(resolve => { entered = resolve; });
      const hold = new Promise<void>(resolve => { release = resolve; });
      f.setInspectGate(async read => { if (read === target) { entered(); await hold; } });
      const activation = f.runtime.activate(pending.candidateId, f.confirm(pending));
      void activation.catch(() => {}); await reached;
      if (event === 'stop') f.runtime.close();
      else if (event === 'SessionStart') await assert.rejects(f.runtime.handle(f.request(event)));
      else await f.runtime.handle(f.request(event));
      release(); await assert.rejects(activation);
      await assert.rejects(f.runtime.describe('claude-code'));
    }
  }
});
test('End during original route factory and socket deletion after activation close business', async t => {
  const f = await fixture(t); await f.runtime.handle(f.request()); const candidate = await f.runtime.whenCandidate;
  let entered!: () => void; let release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; }); const hold = new Promise<void>(resolve => { release = resolve; });
  f.setRouteGate(async () => { entered(); await hold; });
  const activation = f.runtime.activate(candidate.candidateId, f.confirm(candidate)); void activation.catch(() => {});
  await reached; await f.runtime.handle(f.request('SessionEnd')); release(); await assert.rejects(activation);
  const active = await fixture(t); await active.runtime.handle(active.request()); const other = await active.runtime.whenCandidate;
  await active.runtime.activate(other.candidateId, active.confirm(other)); rmSync(active.path);
  await assert.rejects(active.runtime.describe('claude-code'));
  await assert.rejects(active.runtime.describe('claude-code'));
});
test('valid pending Skill policy denial preserves candidate for later activation', async t => {
  const f = await fixture(t); await f.runtime.handle(f.request()); const candidate = await f.runtime.whenCandidate;
  const start = f.request();
  const skill = { ...start, payload: { profile: 'app-code', startup: null, hook: {
    hook_event_name: 'PreToolUse', session_id: sid, transcript_path: '/t', cwd: '/w', tool_name: 'Skill', tool_use_id: 'pending-call',
    tool_input: { skill: `ms-app-message-${sid.slice(0, 8)}`, args: JSON.stringify({ schemaVersion: 1, operation: 'list', harness: 'dsh' }) },
  } } };
  await assert.rejects(f.runtime.handle(skill), /APP_ADMISSION_NOT_ACTIVE/);
  assert.equal(f.routes(), 0);
  await f.runtime.activate(candidate.candidateId, f.confirm(candidate));
  assert.equal((await f.runtime.describe('claude-code')).length, 1); f.runtime.close();
});

test('non-App CLI has no revocation authority even for End, malformed wrapper or Start', async t => {
  const f = await fixture(t); await f.runtime.handle(f.request()); const candidate = await f.runtime.whenCandidate;
  for (const payload of [f.request('SessionEnd').payload, {}, f.request().payload]) {
    await assert.rejects(f.runtime.handle({ ...f.request(), peer: terminalCli, payload }));
  }
  await f.runtime.activate(candidate.candidateId, f.confirm(candidate));
  assert.equal(f.routes(), 1); f.runtime.close();
});
test('another App-authenticated CLI second Start closes run for same and different SID', async t => {
  for (const nativeSid of [sid, '87654321-4321-4321-8321-abcdef123456']) {
    const f = await fixture(t); await f.runtime.handle(f.request()); const candidate = await f.runtime.whenCandidate;
    await assert.rejects(f.runtime.handle({ ...f.request('SessionStart', nativeSid), peer: otherCli }));
    await assert.rejects(f.runtime.activate(candidate.candidateId, f.confirm(candidate))); assert.equal(f.routes(), 0);
  }
});
test('revocation notification resolves for End, activation errors and second Start', async t => {
  for (const cause of ['end', 'activation', 'start', 'wrapper', 'socket']) {
    const f = await fixture(t); const revoked = f.runtime.whenRevoked;
    assert.equal(revoked instanceof Promise, true);
    await f.runtime.handle(f.request()); const candidate = await f.runtime.whenCandidate;
    if (cause === 'end') await f.runtime.handle(f.request('SessionEnd'));
    if (cause === 'activation') await assert.rejects(f.runtime.activate(candidate.candidateId, {}));
    if (cause === 'start') await assert.rejects(f.runtime.handle(f.request()));
    if (cause === 'wrapper') await assert.rejects(f.runtime.handle({ ...f.request(), payload: {} }));
    if (cause === 'socket') {
      await f.runtime.activate(candidate.candidateId, f.confirm(candidate)); rmSync(f.path);
      await assert.rejects(f.runtime.describe('claude-code'));
    }
    assert.equal(await revoked, cause === 'end' ? 'APP_SESSION_ENDED' : 'APP_ADMISSION_REVOKED');
    f.runtime.invalidate('later-reason');
    assert.equal(await revoked, cause === 'end' ? 'APP_SESSION_ENDED' : 'APP_ADMISSION_REVOKED');
  }
});
test('unauthenticated peer errors do not resolve revocation notification', async t => {
  const f = await fixture(t); let revoked = false;
  void f.runtime.whenRevoked.then(() => { revoked = true; });
  await f.runtime.handle(f.request()); const candidate = await f.runtime.whenCandidate;
  for (const peer of [terminalCli, { ...cli, pid: 999 }]) {
    await assert.rejects(f.runtime.handle({ ...f.request('SessionEnd'), peer }));
    await Promise.resolve(); assert.equal(revoked, false);
  }
  await f.runtime.activate(candidate.candidateId, f.confirm(candidate));
  assert.equal(revoked, false); f.runtime.close(); await f.runtime.whenRevoked; assert.equal(revoked, true);
});

test('activating denies previously obtained DSH connect/send/reply and dispatches zero frames', async t => {
  const f = await fixture(t); const source = f.runtime.registerDsh({ agent: f.actor });
  await f.runtime.handle(f.request()); const candidate = await f.runtime.whenCandidate;
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  f.setRouteGate(async () => { entered.resolve(); await release.promise; });
  const activation = f.runtime.activate(candidate.candidateId, f.confirm(candidate)); await entered.promise;
  await assert.rejects(source.connect(sid));
  await assert.rejects(source.send({ schemaVersion: 1, messageId: 'pending-send', linkId: 'no-link', body: 'synthetic' }));
  await assert.rejects(source.reply({ schemaVersion: 1, messageId: 'pending-reply', inReplyTo: 'no-message', body: 'synthetic' }));
  assert.equal(f.appFrames.length + f.dshFrames.length, 0); assert.deepEqual(await f.runtime.describe('claude-code'), []);
  release.resolve(); await activation; f.runtime.close();
});
async function communicatingFixture(t: TestContext) {
  const f = await fixture(t); const source = f.runtime.registerDsh({ agent: f.actor });
  await f.runtime.handle(f.request()); const candidate = await f.runtime.whenCandidate;
  await f.runtime.activate(candidate.candidateId, f.confirm(candidate)); const linkId = await source.connect(sid);
  await source.send({ schemaVersion: 1, messageId: 'seed-dsh', linkId, body: 'synthetic DSH' });
  await f.call({ schemaVersion: 1, operation: 'reply', messageId: 'seed-app-reply', inReplyTo: 'seed-dsh', body: 'synthetic App reply' }, 'seed-reply');
  await f.call({ schemaVersion: 1, operation: 'send', messageId: 'seed-app', linkId, body: 'synthetic App' }, 'seed-send');
  await source.reply({ schemaVersion: 1, messageId: 'seed-dsh-reply', inReplyTo: 'seed-app', body: 'synthetic DSH reply' });
  return { ...f, source, linkId };
}
test('active App and DSH send and reply through real shared Duplex and channel', async t => {
  const f = await communicatingFixture(t);
  assert.deepEqual(f.appFrames.map(frame => [frame.messageId, frame.recipient.nativeSessionId, frame.body]),
    [['seed-dsh', sid, 'synthetic DSH'], ['seed-dsh-reply', sid, 'synthetic DSH reply']]);
  assert.deepEqual(f.dshFrames.map(frame => [frame.messageId, frame.recipient.nativeSessionId, frame.body]),
    [['seed-app-reply', f.actor.id, 'synthetic App reply'], ['seed-app', f.actor.id, 'synthetic App']]);
  f.runtime.close();
});
const businessOperations = ['dsh-send', 'dsh-reply', 'app-send', 'app-reply'] as const;
function dispatch(f: Awaited<ReturnType<typeof communicatingFixture>>, operation: typeof businessOperations[number]) {
  const messageId = `blocked-${operation}`;
  if (operation === 'dsh-send') return f.source.send({ schemaVersion: 1, messageId, linkId: f.linkId, body: 'blocked synthetic' });
  if (operation === 'dsh-reply') return f.source.reply({ schemaVersion: 1, messageId, inReplyTo: 'seed-app', body: 'blocked synthetic' });
  return f.call({ schemaVersion: 1, operation: operation === 'app-send' ? 'send' : 'reply', messageId,
    ...(operation === 'app-send' ? { linkId: f.linkId } : { inReplyTo: 'seed-dsh' }), body: 'blocked synthetic' }, messageId);
}
for (const operation of businessOperations) {
  test(`${operation} final kernel await rejects End, second Start, stop and socket replacement without another push`, async t => {
    const baseline = await communicatingFixture(t); const initialReads = baseline.reads();
    await dispatch(baseline, operation); const businessReads = baseline.pushReads.at(-1)! - initialReads; baseline.runtime.close();
    assert.ok(businessReads > 0);
    for (const event of ['end', 'start', 'stop', 'socket']) {
      const f = await communicatingFixture(t); const count = f.appFrames.length + f.dshFrames.length;
      const target = f.reads() + businessReads;
      const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
      f.setInspectGate(async read => { if (read === target) { entered.resolve(); await release.promise; } });
      const sending = dispatch(f, operation); void sending.catch(() => {}); await entered.promise;
      if (event === 'end') await f.runtime.handle(f.request('SessionEnd'));
      if (event === 'start') await assert.rejects(f.runtime.handle({ ...f.request(), peer: otherCli }));
      if (event === 'stop') f.runtime.close();
      if (event === 'socket') await f.replaceSocket();
      release.resolve();
      const [outcome] = await Promise.allSettled([sending]);
      if (outcome.status === 'fulfilled') {
        assert.equal((outcome.value as { state: string }).state, 'delivery-unknown');
        assert.equal((outcome.value as { transport: unknown }).transport, null);
      }
      assert.equal(f.appFrames.length + f.dshFrames.length, count);
      await f.runtime.whenRevoked;
    }
  });
}
test('another App CLI second Start with invalid source revokes pending and active runs', async t => {
  for (const active of [false, true]) {
    const f = await fixture(t); await f.runtime.handle(f.request()); const candidate = await f.runtime.whenCandidate;
    if (active) await f.runtime.activate(candidate.candidateId, f.confirm(candidate));
    const start = f.request();
    await assert.rejects(f.runtime.handle({ ...start, peer: otherCli, payload: { ...start.payload, hook: { ...start.payload.hook, source: 'resume' } } }));
    assert.equal(await f.runtime.whenRevoked, 'APP_ADMISSION_REVOKED');
    await assert.rejects(f.runtime.describe('claude-code')); assert.equal(f.appFrames.length + f.dshFrames.length, 0);
  }
});
