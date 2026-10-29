// INPUT: A scripted fake launchctl, temp plist paths and the fake msd socket.
// OUTPUT: daemon start/stop/status command sequences, readiness wait and fixed launchd error regressions.
// POS: Offline LaunchAgent lifecycle tests; never invokes the real launchctl or a real msd.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runDaemon, type DaemonDeps } from '../../src/cli/daemon.ts';
import { kickstartService, renderPlist, type Launchctl } from '../../src/cli/launchd.ts';
import { LAUNCH_AGENT_LABEL, resolvePaths } from '../../src/cli/paths.ts';
import { startFakeDaemon, okReply } from './fake-daemon.ts';

const STATUS = {
  version: '0.1.0', startedAt: '2026-10-20T08:00:00.000Z',
  sessions: { 'claude-code': { online: 0, offline: 0 }, dsh: { online: 0, offline: 0 }, codex: { online: 0, offline: 0 } },
  links: { total: 0, suspended: 0, paused: 0 }, autoRegister: { 'claude-code': false, dsh: false, codex: false }, autoRegisterProjects: [],
  replyMode: { 'claude-code': 'direct', dsh: 'direct', codex: 'direct' }, actPreset: { 'claude-code': 'workspace-write', dsh: 'workspace-write', codex: 'workspace-write' },
  adapters: { dsh: 0, codex: 0 },
};
const SERVICE = `gui/501/${LAUNCH_AGENT_LABEL}`;
const RUNNING = `${SERVICE} = {\n\tstate = running\n\tpid = 4242\n}`;

function fakeLaunchctl(script: Array<{ args: string[]; code: number; stdout?: string }>): { launchctl: Launchctl; calls: string[][] } {
  const calls: string[][] = [];
  const launchctl: Launchctl = async args => {
    calls.push([...args]);
    const step = script.shift();
    assert.ok(step, `unexpected launchctl ${args.join(' ')}`);
    assert.deepEqual([...args], step.args);
    return { code: step.code, stdout: step.stdout ?? '' };
  };
  return { launchctl, calls };
}

async function withHome(run: (paths: ReturnType<typeof resolvePaths>, socket: string) => Promise<void>, reply = okReply(STATUS)): Promise<void> {
  const home = await mkdtemp('/tmp/ms-daemon-');
  const daemon = await startFakeDaemon(reply);
  try { await run(resolvePaths(home), daemon.socketPath); } finally {
    await daemon.close();
    await rm(home, { recursive: true, force: true });
  }
}

function deps(paths: ReturnType<typeof resolvePaths>, socket: string, launchctl: Launchctl): DaemonDeps {
  return { paths: { ...paths, socket }, launchctl, uid: 501, controlTimeoutMs: 1000, readyTimeoutMs: 1000, sleep: async () => undefined };
}

test('start bootstraps the installed plist into gui/<uid> and waits for the control socket', async () => {
  await withHome(async (paths, socket) => {
    await mkdir(join(paths.home, 'Library/LaunchAgents'), { recursive: true });
    await writeFile(paths.launchAgent, renderPlist({ label: LAUNCH_AGENT_LABEL, program: ['/n', '/m.ts'], workingDirectory: '/', stdoutPath: '/o', stderrPath: '/e' }));
    const fake = fakeLaunchctl([
      { args: ['print', SERVICE], code: 113 },
      { args: ['bootstrap', 'gui/501', paths.launchAgent], code: 0 },
      { args: ['print', SERVICE], code: 0, stdout: RUNNING },
    ]);
    assert.equal(await runDaemon('start', deps(paths, socket, fake.launchctl)), 'msd 0.1.0 started\nlaunchd: loaded, state running, pid 4242');
  });
});

test('start without install is NOT_INSTALLED and an already loaded service is not bootstrapped twice', async () => {
  await withHome(async (paths, socket) => {
    const none = fakeLaunchctl([]);
    await assert.rejects(runDaemon('start', deps(paths, socket, none.launchctl)), { code: 'NOT_INSTALLED' });
    await mkdir(join(paths.home, 'Library/LaunchAgents'), { recursive: true });
    await writeFile(paths.launchAgent, 'x');
    const loaded = fakeLaunchctl([{ args: ['print', SERVICE], code: 0, stdout: RUNNING }]);
    assert.equal(await runDaemon('start', deps(paths, socket, loaded.launchctl)), 'msd already loaded\nlaunchd: loaded, state running, pid 4242');
  });
});

test('start reports DAEMON_START_TIMEOUT with the log hint when the socket never appears and LAUNCHD_FAILED on bootstrap errors', async () => {
  await withHome(async (paths) => {
    await mkdir(join(paths.home, 'Library/LaunchAgents'), { recursive: true });
    await writeFile(paths.launchAgent, 'x');
    const silent = fakeLaunchctl([{ args: ['print', SERVICE], code: 113 }, { args: ['bootstrap', 'gui/501', paths.launchAgent], code: 0 }]);
    const waiting = { ...deps(paths, '/tmp/ms-cli-absent/msd.sock', silent.launchctl), readyTimeoutMs: 0 };
    await assert.rejects(runDaemon('start', waiting), (error: { code: string; detail: string }) => error.code === 'DAEMON_START_TIMEOUT'
      && error.detail.includes(join(paths.logs, 'msd.err.log')) && error.detail.includes('HELPER_START_FAILED') && error.detail.includes('ms repin')
      && error.detail.includes('another user'));
    const failing = fakeLaunchctl([{ args: ['print', SERVICE], code: 113 }, { args: ['bootstrap', 'gui/501', paths.launchAgent], code: 5 }]);
    await assert.rejects(runDaemon('start', deps(paths, '/tmp/x.sock', failing.launchctl)), { code: 'LAUNCHD_FAILED', detail: 'bootstrap exit 5' });
  });
});

test('stop boots out only a loaded service', async () => {
  await withHome(async (paths, socket) => {
    const loaded = fakeLaunchctl([{ args: ['print', SERVICE], code: 0, stdout: RUNNING }, { args: ['bootout', SERVICE], code: 0 }]);
    assert.equal(await runDaemon('stop', deps(paths, socket, loaded.launchctl)), 'msd stopped');
    const absent = fakeLaunchctl([{ args: ['print', SERVICE], code: 113 }]);
    assert.equal(await runDaemon('stop', deps(paths, socket, absent.launchctl)), 'msd not loaded');
    const broken = fakeLaunchctl([{ args: ['print', SERVICE], code: 1 }]);
    await assert.rejects(runDaemon('stop', deps(paths, socket, broken.launchctl)), { code: 'LAUNCHD_FAILED' });
  });
});

test('status combines launchd state with control reachability', async () => {
  await withHome(async (paths, socket) => {
    const loaded = fakeLaunchctl([{ args: ['print', SERVICE], code: 0, stdout: RUNNING }]);
    assert.equal(await runDaemon('status', deps(paths, socket, loaded.launchctl)), 'launchd: loaded, state running, pid 4242\ncontrol: reachable (msd 0.1.0)');
    const absent = fakeLaunchctl([{ args: ['print', SERVICE], code: 113 }]);
    assert.equal(await runDaemon('status', deps(paths, '/tmp/ms-cli-absent/msd.sock', absent.launchctl)), 'launchd: not loaded\ncontrol: DAEMON_UNAVAILABLE');
  });
});

test('plist escapes XML and pins program arguments, private umask and log paths', () => {
  const plist = renderPlist({
    label: LAUNCH_AGENT_LABEL, program: ['/h/a&b/runtime/node', '/h/a&b/src/daemon/main.ts'], workingDirectory: '/h/a&b',
    stdoutPath: '/h/<logs>/msd.out.log', stderrPath: '/h/logs/msd.err.log',
  });
  assert.match(plist, /<string>\/h\/a&amp;b\/runtime\/node<\/string>\n {4}<string>\/h\/a&amp;b\/src\/daemon\/main.ts<\/string>/);
  assert.match(plist, /<key>Umask<\/key><integer>63<\/integer>/);
  assert.match(plist, /&lt;logs&gt;/);
  assert.throws(() => renderPlist({ label: 'x', program: ['/a\u0001'], workingDirectory: '/', stdoutPath: '/o', stderrPath: '/e' }), { code: 'INSTALL_PRECONDITION_FAILED' });
});

test('kickstart restarts a loaded service and reports an unloaded one', async () => {
  const loaded = fakeLaunchctl([{ args: ['kickstart', '-k', SERVICE], code: 0 }]);
  assert.equal(await kickstartService(loaded.launchctl, 'gui/501', LAUNCH_AGENT_LABEL), true);
  const absent = fakeLaunchctl([{ args: ['kickstart', '-k', SERVICE], code: 113 }]);
  assert.equal(await kickstartService(absent.launchctl, 'gui/501', LAUNCH_AGENT_LABEL), false);
  const broken = fakeLaunchctl([{ args: ['kickstart', '-k', SERVICE], code: 1 }]);
  await assert.rejects(kickstartService(broken.launchctl, 'gui/501', LAUNCH_AGENT_LABEL), { code: 'LAUNCHD_FAILED' });
});

test('stop treats a bootout that races with an already-gone service as stopped, and fails while it is still loaded', async () => {
  await withHome(async (paths, socket) => {
    const raced = fakeLaunchctl([
      { args: ['print', SERVICE], code: 0, stdout: RUNNING }, { args: ['bootout', SERVICE], code: 3 }, { args: ['print', SERVICE], code: 113 },
    ]);
    assert.equal(await runDaemon('stop', deps(paths, socket, raced.launchctl)), 'msd stopped');
    const stuck = fakeLaunchctl([
      { args: ['print', SERVICE], code: 0, stdout: RUNNING }, { args: ['bootout', SERVICE], code: 5 }, { args: ['print', SERVICE], code: 0, stdout: RUNNING },
    ]);
    await assert.rejects(runDaemon('stop', deps(paths, socket, stuck.launchctl)), { code: 'LAUNCHD_FAILED', detail: 'bootout exit 5' });
  });
});
