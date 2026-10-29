// INPUT: Mixed fixture with both entries bound, real temporary sockets and recorded pushes/End callbacks.
// OUTPUT: M3 partial End ordering, M4 socket/surface and M5 per-target guard regressions.
// POS: Offline mixed runtime tests; no real App, CLI, DSH or model.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mixedFixture, cliSid, appSid } from './bridge-mixed-fixture.ts';

const closedWith = async (runtime: { whenRevoked: Promise<string> }) => Promise.race([runtime.whenRevoked,
  new Promise<string>(resolve => setImmediate(() => resolve('OPEN')))]);
const sids = async (runtime: any) => (await runtime.describe('claude-code')).map((entry: any) => entry.endpoint.nativeSessionId).sort();

async function roundTrip(f: any, source: any, sid: string, call: 'cliCall' | 'appCall', tag: string) {
  const linkId = await source.connect(sid);
  await source.send({ schemaVersion: 1, messageId: `dsh-${tag}`, linkId, body: `body ${tag}` });
  const result = await f[call]({ schemaVersion: 1, operation: 'reply', messageId: `claude-${tag}`,
    inReplyTo: `dsh-${tag}`, body: `answer ${tag}` }, `reply-${tag}`);
  assert.ok('receipt' in result);
  return linkId;
}

test('interleaved business reaches only the addressed entry, and the session list counts both entries', async t => {
  const f = await mixedFixture(t); const source = await f.ready();
  assert.deepEqual(await sids(f.runtime), [cliSid, appSid].sort());
  await roundTrip(f, source, appSid, 'appCall', 'a1');
  await roundTrip(f, source, cliSid, 'cliCall', 'b1');
  await roundTrip(f, source, appSid, 'appCall', 'a2');
  assert.deepEqual(f.claudeFrames.map(frame => frame.recipient.nativeSessionId), [appSid, cliSid, appSid]);
  assert.deepEqual(f.dshFrames.map(frame => frame.sender.nativeSessionId), [appSid, cliSid, appSid]);
  assert.equal(f.dispatches(), 6);
  const surfaces = (await f.runtime.describe('claude-code')).map((entry: any) => [entry.endpoint.nativeSessionId, f.runtime.surfaceOf(entry.endpoint)]);
  assert.deepEqual(Object.fromEntries(surfaces), { [cliSid]: 'cli', [appSid]: 'desktop' });
});

test('CLI End revokes only CLI, keeps settlement untouched and still serves a full App round trip', async t => {
  const f = await mixedFixture(t); const source = await f.ready();
  const cliLink = await roundTrip(f, source, cliSid, 'cliCall', 'b1');
  assert.deepEqual(await f.cliEnd(), { prepared: true });
  assert.equal(await closedWith(f.runtime), 'OPEN'); assert.deepEqual(f.ends, []);
  assert.deepEqual(await sids(f.runtime), [appSid]);
  const before = { frames: f.claudeFrames.length, dispatches: f.dispatches() };
  await assert.rejects(source.send({ schemaVersion: 1, messageId: 'late', linkId: cliLink, body: 'late' }), /SESSION_EPOCH_REVOKED/);
  await assert.rejects(f.cliCall({ schemaVersion: 1, operation: 'send', messageId: 'late-cli', linkId: cliLink, body: 'x' }, 'late'),
    /UNREGISTERED_CLAUDE_SESSION/);
  assert.deepEqual({ frames: f.claudeFrames.length, dispatches: f.dispatches() }, before);
  assert.equal(await closedWith(f.runtime), 'OPEN');
  await roundTrip(f, source, appSid, 'appCall', 'a1');
  const end = f.appEnd();
  assert.deepEqual(await end.done, { prepared: true });
  assert.deepEqual(f.ends, [end.request.requestId]);
  assert.equal(await f.runtime.whenRevoked, 'APP_SESSION_ENDED');
});

test('App End before CLI End is abnormal: whole run closes and settlement is not notified', async t => {
  const f = await mixedFixture(t); await f.ready();
  await assert.rejects(f.appEnd().done, /MIXED_APP_END_BEFORE_CLI/);
  assert.equal(await f.runtime.whenRevoked, 'MIXED_APP_END_BEFORE_CLI'); assert.deepEqual(f.ends, []);
});

test('a resume or new Start after CLI End is an extra Start and closes the run without App settlement', async t => {
  const f = await mixedFixture(t); await f.ready(); await f.cliEnd();
  await assert.rejects(f.cliStart({ source: 'resume' }));
  assert.notEqual(await closedWith(f.runtime), 'OPEN');
  await assert.rejects(f.appEnd().done); assert.deepEqual(f.ends, []);
});

test('a CLI request in flight at CLI End fails with a fixed code and does not block final App End', async t => {
  const f = await mixedFixture(t); const source = await f.ready();
  await roundTrip(f, source, cliSid, 'cliCall', 'b1');
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); const reached = new Promise<void>(resolve => { entered = resolve; });
  f.setInspectGate(async pid => { if (pid === f.table().login.pid) { entered(); await gate; } });
  const inFlight = f.cliCall({ schemaVersion: 1, operation: 'connect', targetSessionId: f.actor.id }, 'slow');
  await reached; f.setInspectGate(async () => {});
  await f.cliEnd(); release();
  await assert.rejects(inFlight, /SESSION_EPOCH_REVOKED|UNREGISTERED_CLAUDE_SESSION/);
  assert.equal(await closedWith(f.runtime), 'OPEN');
  const end = f.appEnd(); await end.done; assert.deepEqual(f.ends, [end.request.requestId]);
});

test('CLI socket replacement while bound closes the whole run on the next check', async t => {
  const f = await mixedFixture(t); const source = await f.ready();
  await f.replaceSocket(f.cliSocket);
  await assert.rejects(source.connect(appSid), /APP_SOCKET_UNAVAILABLE/);
  assert.notEqual(await closedWith(f.runtime), 'OPEN');
});

test('App guard failure cannot be bypassed through the CLI target', async t => {
  const f = await mixedFixture(t); const source = await f.ready();
  await f.replaceSocket(f.appSocket);
  await assert.rejects(source.connect(cliSid), /APP_SOCKET_UNAVAILABLE/);
  assert.notEqual(await closedWith(f.runtime), 'OPEN'); assert.equal(f.claudeFrames.length, 0);
});

test('App pending blocks business on both sides without closing; App is not listed until active', async t => {
  const f = await mixedFixture(t);
  await f.cliStart(); await f.appStart();
  assert.deepEqual(await sids(f.runtime), [cliSid]);
  const source = f.runtime.registerDsh({ agent: f.actor });
  await assert.rejects(source.connect(cliSid), /MIXED_NOT_READY/);
  await assert.rejects(f.cliCall({ schemaVersion: 1, operation: 'connect', targetSessionId: f.actor.id }, 'early'), /MIXED_NOT_READY/);
  await assert.rejects(f.appCall({ schemaVersion: 1, operation: 'connect', targetSessionId: f.actor.id }, 'early-app'), /APP_ADMISSION_NOT_ACTIVE/);
  assert.equal(await closedWith(f.runtime), 'OPEN'); assert.equal(f.dispatches(), 0);
  await f.activate();
  assert.deepEqual(await sids(f.runtime), [cliSid, appSid].sort());
  assert.ok(await source.connect(cliSid));
});

test('surface comes from the entry quota and unknown endpoints have no surface', async t => {
  const f = await mixedFixture(t); await f.ready();
  const [first] = await f.runtime.describe('claude-code');
  assert.throws(() => f.runtime.surfaceOf({ ...first.endpoint, nativeSessionId: '00000000-0000-4000-8000-0000000000ff' }), /UNKNOWN_MIXED_SURFACE/);
});

test('a bound CLI identity change before End closes the whole run on the next check', async t => {
  const f = await mixedFixture(t); const source = await f.ready();
  f.setTable({ cli: { ...f.table().cli, pidVersion: f.table().cli.pidVersion + 100 } });
  await assert.rejects(source.connect(cliSid), /INVALID_PEER_IDENTITY/);
  assert.notEqual(await closedWith(f.runtime), 'OPEN');
});

test('a bound CLI ancestry change to an App helper closes the whole run', async t => {
  const f = await mixedFixture(t); const source = await f.ready(); const { shell } = f.table();
  f.setTable({ shell: { ...shell, exe: '/fx/Helper', sha256: 'd'.repeat(64) } });
  await assert.rejects(source.connect(cliSid), /INVALID_CLI_ANCESTRY/);
  assert.notEqual(await closedWith(f.runtime), 'OPEN');
});

test('CLI End before CLI binding or from another standalone CLI is unexpected and closes the run', async t => {
  const early = await mixedFixture(t);
  await assert.rejects(early.cliEnd(), /MIXED_UNEXPECTED_END/);
  assert.equal(await early.runtime.whenRevoked, 'MIXED_UNEXPECTED_END');
  const other = await mixedFixture(t); await other.ready();
  const { shell } = other.table(); const { proc, pins } = await import('./bridge-mixed-fixture.ts');
  const second = proc(60, shell, pins.cli); const hook = proc(61, second, pins.wrapper); other.setTable({ second, hook });
  await assert.rejects(other.runtime.handle(other.cliRequest({ hook_event_name: 'SessionEnd', session_id: cliSid,
    transcript_path: '/t', cwd: '/w', reason: 'exit' }, hook)), /MIXED_UNEXPECTED_END/);
  assert.equal(await other.runtime.whenRevoked, 'MIXED_UNEXPECTED_END');
});

test('one attached directory serves the list operation on both entries and releases both channels', async t => {
  const { SESSION_DIRECTORY_NOTE } = await import('../../src/registry/session-view.ts');
  const f = await mixedFixture(t); await f.ready(); let reads = 0;
  const release = f.runtime.attachDirectory(async () => { reads += 1; return { sessions: [], note: SESSION_DIRECTORY_NOTE }; });
  const list = { schemaVersion: 1, operation: 'list', harness: 'dsh' };
  assert.deepEqual(await f.cliCall(list, 'list-cli'), { sessions: [], note: SESSION_DIRECTORY_NOTE });
  assert.deepEqual(await f.appCall(list, 'list-app'), { sessions: [], note: SESSION_DIRECTORY_NOTE });
  assert.equal(reads, 2); release();
  await assert.rejects(f.cliCall(list, 'list-after'), /METADATA_QUERY_UNAVAILABLE|CLAUDE_CHANNEL/);
});

async function abnormalAppEnd(f: any, request: any) {
  await assert.rejects(f.runtime.handle(request));
  assert.notEqual(await f.runtime.whenRevoked, 'APP_SESSION_ENDED'); assert.deepEqual(f.ends, []);
}

test('after CLI End, a SessionEnd from another App-hosted CLI generation is abnormal and never settles', async t => {
  const f = await mixedFixture(t); await f.ready(); await f.cliEnd();
  const { helper } = f.table(); const { proc, pins } = await import('./bridge-mixed-fixture.ts');
  const otherCli = proc(70, helper, pins.appCli); const otherHook = proc(71, otherCli, pins.wrapper); f.setTable({ otherCli, otherHook });
  await abnormalAppEnd(f, f.appRequest({ hook_event_name: 'SessionEnd', session_id: appSid, transcript_path: '/t', cwd: '/w', reason: 'exit' }, null, otherHook));
});

test('App End while admission is still pending is abnormal even after a normal CLI End', async t => {
  const f = await mixedFixture(t); await f.cliStart(); await f.appStart(); await f.cliEnd();
  await abnormalAppEnd(f, f.appRequest({ hook_event_name: 'SessionEnd', session_id: appSid, transcript_path: '/t', cwd: '/w', reason: 'exit' }));
});

test('App End naming a SID other than the candidate SID is abnormal', async t => {
  const f = await mixedFixture(t); await f.ready(); await f.cliEnd();
  await abnormalAppEnd(f, f.appRequest({ hook_event_name: 'SessionEnd', session_id: '00000000-0000-4000-8000-0000000000aa',
    transcript_path: '/t', cwd: '/w', reason: 'exit' }));
});

test('the candidate App End is accepted with a case-insensitive SID match', async t => {
  const f = await mixedFixture(t); await f.ready(); await f.cliEnd();
  const request = f.appRequest({ hook_event_name: 'SessionEnd', session_id: appSid.toUpperCase(), transcript_path: '/t', cwd: '/w', reason: 'exit' });
  assert.deepEqual(await f.runtime.handle(request), { prepared: true });
  assert.deepEqual(f.ends, [request.requestId]); assert.equal(await f.runtime.whenRevoked, 'APP_SESSION_ENDED');
});
