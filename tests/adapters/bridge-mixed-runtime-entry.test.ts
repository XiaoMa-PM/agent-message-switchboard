// INPUT: Mixed fixture with synthetic kernel chains, real temporary sockets and CLI/App hook payloads.
// OUTPUT: M1 kernel routing and M2 per-entry Start quota/shared-epoch regressions.
// POS: Offline mixed runtime tests; no real App, CLI, DSH or model.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mixedFixture, proc, pins, cliSid, appSid } from './bridge-mixed-fixture.ts';

const closedWith = async (runtime: { whenRevoked: Promise<string> }) => Promise.race([runtime.whenRevoked,
  new Promise<string>(resolve => setImmediate(() => resolve('OPEN')))]);

test('authentication failures reject only that request and consume no entry quota', async t => {
  const f = await mixedFixture(t); const table = f.table();
  const nestedApp = proc(40, table.cli, pins.appCli); const nestedHook = proc(41, nestedApp, pins.wrapper);
  const underApp = proc(42, table.appCli, pins.cli); const underAppHook = proc(43, underApp, pins.wrapper);
  const bareShell = proc(44, null, pins.wrapper); const orphanApp = proc(45, bareShell, pins.appCli); const orphanHook = proc(46, orphanApp, pins.wrapper);
  f.setTable({ nestedApp, nestedHook, underApp, underAppHook, bareShell, orphanApp, orphanHook });
  const start = { hook_event_name: 'SessionStart', session_id: cliSid, transcript_path: '/t', cwd: '/w', source: 'startup' };
  await assert.rejects(f.runtime.handle(f.appRequest(start, { socketPath: f.appSocket }, nestedHook)), /INVALID_APP_ANCESTRY/);
  await assert.rejects(f.runtime.handle(f.cliRequest(start, underAppHook)), /INVALID_CLI_ANCESTRY/);
  await assert.rejects(f.runtime.handle(f.appRequest(start, { socketPath: f.appSocket }, orphanHook)), /INVALID_APP_ANCESTRY/);
  const vanished = proc(47, proc(48, null, pins.wrapper), pins.cli); const vanishedHook = proc(49, vanished, pins.wrapper);
  f.setTable({ vanished, vanishedHook });
  await assert.rejects(f.runtime.handle(f.cliRequest(start, vanishedHook)), /INVALID_CLI_ANCESTRY/);
  assert.equal(await closedWith(f.runtime), 'OPEN');
  await f.cliStart(); await f.appStart(); await f.activate();
  assert.equal(await closedWith(f.runtime), 'OPEN');
});

test('payload parser follows the kernel class: App wrapper under CLI is rejected, plain payload under App closes', async t => {
  const f = await mixedFixture(t);
  await assert.rejects(f.runtime.handle(f.cliRequest({ profile: 'app-code', startup: null,
    hook: { hook_event_name: 'SessionStart', session_id: cliSid } })), /INVALID_HOOK_EVENT/);
  assert.equal(await closedWith(f.runtime), 'OPEN');
  await f.cliStart();
  await assert.rejects(f.runtime.handle(f.cliRequest({ hook_event_name: 'SessionStart', session_id: appSid,
    transcript_path: '/t', cwd: '/w', source: 'startup' }, f.table().appHook)), /INVALID_APP_HOOK/);
  assert.notEqual(await closedWith(f.runtime), 'OPEN');
});

for (const [name, run] of [
  ['CLI Start with a SID other than the plan SID', (f: any) => f.cliStart({}, appSid)],
  ['second CLI Start from the same process', async (f: any) => { await f.cliStart(); return f.cliStart(); }],
  ['second CLI Start from another standalone CLI', async (f: any) => {
    await f.cliStart(); const table = f.table(); const other = proc(50, table.shell, pins.cli); const hook = proc(51, other, pins.wrapper);
    f.setTable({ other, hook });
    return f.runtime.handle(f.cliRequest({ hook_event_name: 'SessionStart', session_id: cliSid, transcript_path: '/t', cwd: '/w', source: 'startup' }, hook));
  }],
  ['second App Start', async (f: any) => { await f.appStart(); return f.appStart(); }],
  ['CLI Start with a resume source', (f: any) => f.cliStart({ source: 'resume' })],
  ['CLI Start with an unknown field', (f: any) => f.cliStart({ extra: true })],
] as const) {
  test(`${name} closes the whole run`, async t => {
    const f = await mixedFixture(t);
    await assert.rejects(Promise.resolve().then(() => run(f)));
    assert.notEqual(await closedWith(f.runtime), 'OPEN');
    await assert.rejects(f.appStart(), /MIXED_RUN_CLOSED|APP_ADMISSION/);
  });
}

test('CLI Start socket capture failure closes the run after the quota is consumed', async t => {
  const f = await mixedFixture(t);
  const { rmSync } = await import('node:fs'); rmSync(f.cliSocket);
  await assert.rejects(f.cliStart(), /APP_SOCKET_UNAVAILABLE/);
  assert.notEqual(await closedWith(f.runtime), 'OPEN');
});

test('quota is consumed before any await: concurrent duplicate CLI Starts cannot both register', async t => {
  const f = await mixedFixture(t);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  f.setInspectGate(async pid => { if (pid === f.table().login.pid) await gate; });
  const first = f.cliStart(); const second = f.cliStart();
  release();
  const results = await Promise.allSettled([first, second]);
  assert.ok(results.some(result => result.status === 'rejected'));
  assert.notEqual(await closedWith(f.runtime), 'OPEN');
});

for (const order of ['cli-first', 'app-first'] as const) {
  test(`same SID across entries closes the run (${order}, case-insensitive)`, async t => {
    const f = await mixedFixture(t);
    if (order === 'cli-first') {
      await f.cliStart();
      await assert.rejects(f.appStart(cliSid.toUpperCase()));
    } else {
      await assert.rejects(f.appStart(cliSid.toUpperCase()));
      await assert.rejects(f.cliStart(), /MIXED_RUN_CLOSED|ROUNDTRIP|APP_ADMISSION/);
    }
    assert.notEqual(await closedWith(f.runtime), 'OPEN');
  });
}

test('App pending reserves its SID; a CLI Start using it is an unexpected Start and closes the run', async t => {
  const f = await mixedFixture(t);
  await f.appStart();
  await assert.rejects(f.cliStart({}, appSid));
  assert.notEqual(await closedWith(f.runtime), 'OPEN');
});

test('CLI Start while App activation is still pending keeps the App SID reserved and both later bind', async t => {
  const f = await mixedFixture(t);
  await f.appStart(); await f.cliStart(); await f.activate();
  const source = f.runtime.registerDsh({ agent: f.actor });
  const ids = (await f.runtime.describe('claude-code')).map(entry => entry.endpoint.nativeSessionId).sort();
  assert.deepEqual(ids, [cliSid, appSid].sort());
  assert.ok(await source.connect(cliSid)); assert.ok(await source.connect(appSid));
});
