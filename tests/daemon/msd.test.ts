// INPUT: Temporary msd roots, install-shaped config files and an injected fake owned-broker starter.
// OUTPUT: Startup bundle/config artifacts, control readback, hook routing seam, the /ms:auto config write and ordered shutdown regressions.
// POS: Offline msd composition tests; the real Python broker, kernel identity and Claude are not exercised.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMsd } from '../../src/daemon/msd.ts';
import { runPaths } from '../../src/daemon/paths.ts';
import { writeDaemonConfig, type DaemonConfig } from '../../src/daemon/config.ts';
import { NATIVE_FILES } from '../../src/daemon/native-bundle.ts';
import { connectControl } from '../../src/daemon/control-client.ts';
import { type HelperConfig } from '../../src/bridge/helper-process.ts';
import { type StdioRequest } from '../../src/bridge/stdio-rpc.ts';
import { type SignedSnapshot } from '../../src/adapters/claude/peer-identity.ts';
import { ANTHROPIC_TEAM_ID, CLAUDE_IDENTIFIERS } from '../../src/daemon/claude-identity.ts';
import { PRODUCT_VERSION } from '../../src/protocol/product-version.ts';

const pin = (name: string, digit: string) => ({ path: `/opt/${name}`, sha256: digit.repeat(64) });
const config: DaemonConfig = Object.freeze({ schemaVersion: 4, python: pin('python', 'a'),
  claude: { wrapperPins: [pin('sh', 'c')] },
  autoRegister: { 'claude-code': false, dsh: false, codex: false }, autoRegisterProjects: [],
  replyMode: { 'claude-code': 'direct', dsh: 'direct', codex: 'direct' } as const,
  actPreset: { 'claude-code': 'workspace-write', dsh: 'workspace-write', codex: 'workspace-write' } as const, linkBudget: { windowSeconds: 600, maxPushes: 30 } });
const snapshot = (pid: number, exe: string) => Object.freeze({ pid, uid: process.getuid!(), pidVersion: 1, uniqueId: String(pid),
  parentPid: 1, parentUniqueId: '1', exe, sha256: 'd'.repeat(64) });

async function root() {
  const dir = await mkdtemp(join(tmpdir(), 'msd-root-'));
  await chmod(dir, 0o700);
  return dir;
}

function fakeBroker(signed = new Map<number, SignedSnapshot>()) {
  const state: { helper?: HelperConfig; handle?: (request: StdioRequest) => Promise<unknown>; closed: number;
    reads: Array<[string, number]> } = { closed: 0, reads: [] };
  const closed = Promise.withResolvers<string>();
  const start = (async (helper: HelperConfig, handle: (request: StdioRequest) => Promise<unknown>) => {
    state.helper = helper; state.handle = handle;
    return Object.freeze({ childIdentity: snapshot(73, helper.python.path), parentIdentity: snapshot(41, process.execPath),
      whenClosed: closed.promise, inspect: async (pid: number) => { state.reads.push(['inspect', pid]); return null; },
      inspectSigned: async (pid: number) => { state.reads.push(['inspectSigned', pid]); return signed.get(pid) ?? null; },
      quiesce: async () => ({ drained: true }),
      close: async () => { state.closed++; closed.resolve('closed'); } });
  }) as never;
  return { state, start };
}

test('startup rebuilds the pinned native bundle, writes the daily client config and serves control', async () => {
  const dir = await root(); const paths = runPaths(dir);
  await writeDaemonConfig(paths.config, config);
  const broker = fakeBroker();
  const daemon = await startMsd({ root: dir, startBroker: broker.start, projectOf: async cwd => cwd });
  try {
    assert.deepEqual((await readdir(paths.native)).sort(), [...NATIVE_FILES, 'broker-config.json'].sort());
    assert.equal((await lstat(paths.run)).mode & 0o777, 0o700);
    assert.equal((await lstat(paths.native)).mode & 0o777, 0o700);
    for (const codePin of broker.state.helper!.codePins) {
      assert.equal(createHash('sha256').update(await readFile(codePin.path)).digest('hex'), codePin.sha256);
      assert.equal((await lstat(codePin.path)).mode & 0o777, 0o600);
    }
    assert.equal(broker.state.helper!.entryPath, paths.entry);
    const client = JSON.parse(await readFile(paths.client, 'utf8'));
    assert.deepEqual([client.role, client.broker.pid, client.parent.pid, client.socketPath],
      ['daily-client', 73, 41, join(paths.broker, 'broker.sock')]);
    assert.equal((await lstat(paths.client)).mode & 0o777, 0o600);
    const control = await connectControl(paths.control);
    const status = await control.request('status') as { version: string; sessions: unknown };
    assert.equal(status.version, PRODUCT_VERSION);
    assert.deepEqual(status.sessions, { 'claude-code': { online: 0, offline: 0 }, dsh: { online: 0, offline: 0 }, codex: { online: 0, offline: 0 } });
    assert.equal((await lstat(paths.state)).mode & 0o777, 0o700);
    control.close();
    const passed = await broker.state.handle!({ schemaVersion: 1, requestId: randomUUID(), peer: { pid: 99, uid: 0, pidVersion: 1 },
      snapshots: [[], []], payload: { profile: 'daily', messagingSocket: null, hook: { hook_event_name: 'UserPromptSubmit',
        session_id: '11111111-1111-4111-8111-111111111111', prompt: 'hello' } } });
    assert.deepEqual(passed, { hookOutput: {} });
    const refused = await broker.state.handle!({ schemaVersion: 1, requestId: randomUUID(), peer: { pid: 99, uid: 0, pidVersion: 1 },
      snapshots: [[], []], payload: { profile: 'daily', messagingSocket: null, hook: { hook_event_name: 'UserPromptSubmit',
        session_id: '11111111-1111-4111-8111-111111111111', prompt: '/ms:register' } } }) as { hookOutput: { reason: string } };
    assert.match(refused.hookOutput.reason, /登记失败（INVALID_PEER_IDENTITY）/);
    assert.deepEqual(broker.state.reads, [['inspectSigned', 99]]);
  } finally { await daemon.close(); }
  assert.equal(broker.state.closed, 1);
  await assert.rejects(lstat(paths.client)); await assert.rejects(lstat(paths.control));
});

test('/ms:auto from a signed Claude CLI persists only the claude-code flag and control reads it back', async () => {
  const dir = await root(); const paths = runPaths(dir);
  await writeDaemonConfig(paths.config, { ...config, autoRegisterProjects: ['/work'] });
  const uid = process.getuid!();
  const row = (pid: number, parentPid: number, exe: string, sha256: string | null, signing: SignedSnapshot['signing'] = null) =>
    Object.freeze({ pid, uid, pidVersion: 1, uniqueId: String(pid * 10), parentPid, parentUniqueId: parentPid === 1 ? '1' : String(parentPid * 10),
      exe, sha256, signing });
  const chain = [row(102, 101, '/opt/python', 'a'.repeat(64)), row(101, 100, '/opt/sh', 'c'.repeat(64)),
    row(100, 99, '/opt/claude/versions/2.1.306', null, { teamId: ANTHROPIC_TEAM_ID, identifier: CLAUDE_IDENTIFIERS.cli, runtime: true }),
    row(99, 1, '/bin/zsh', 'd'.repeat(64))];
  const broker = fakeBroker(new Map(chain.map(item => [item.pid, item])));
  const daemon = await startMsd({ root: dir, startBroker: broker.start, projectOf: async cwd => cwd });
  const hook = async (prompt: string) => (await broker.state.handle!({ schemaVersion: 1, requestId: randomUUID(),
    peer: { pid: 102, uid, pidVersion: 1 }, snapshots: [[], []], payload: { profile: 'daily', messagingSocket: null,
      hook: { hook_event_name: 'UserPromptSubmit', session_id: '11111111-1111-4111-8111-111111111111', prompt } } }) as
    { hookOutput: { reason: string } }).hookOutput.reason;
  try {
    assert.match(await hook('/ms:auto on'), /^已开启 Switchboard 自动登记（claude-code），范围为仅限名单内的 1 个项目：\/work：/);
    const saved = JSON.parse(await readFile(paths.config, 'utf8'));
    assert.deepEqual([saved.autoRegister, saved.autoRegisterProjects, saved.claude],
      [{ claude: true, dsh: false, codex: false }, ['/work'], config.claude]);
    const control = await connectControl(paths.control);
    assert.deepEqual((await control.request('config.get') as { autoRegister: unknown }).autoRegister,
      { 'claude-code': true, dsh: false, codex: false });
    control.close();
    assert.match(await hook('/ms-auto'), /^Switchboard 自动登记（claude-code）：开，/);
  } finally { await daemon.close(); }
});

test('a restart replaces stale bundle files and a second daemon on the same root is refused', async () => {
  const dir = await root(); const paths = runPaths(dir);
  await writeDaemonConfig(paths.config, config);
  const first = await startMsd({ root: dir, startBroker: fakeBroker().start });
  const second = fakeBroker();
  const clientBefore = await readFile(paths.client, 'utf8');
  const entryBefore = await lstat(paths.entry);
  await assert.rejects(startMsd({ root: dir, startBroker: second.start }), /MSD_ALREADY_RUNNING/);
  assert.equal(second.state.helper, undefined);
  assert.equal(await readFile(paths.client, 'utf8'), clientBefore);
  assert.equal((await lstat(paths.entry)).ino, entryBefore.ino);
  await first.close();
  await writeFile(join(paths.native, 'stray.py'), 'x');
  const again = await startMsd({ root: dir, startBroker: fakeBroker().start });
  try { assert.equal((await readdir(paths.native)).includes('stray.py'), false); } finally { await again.close(); }
});

test('startup refuses a missing, malformed or non-private config without starting the broker', async () => {
  const dir = await root(); const paths = runPaths(dir);
  const broker = fakeBroker();
  await assert.rejects(startMsd({ root: dir, startBroker: broker.start }), /INVALID_CONFIG/);
  await writeFile(paths.config, JSON.stringify({ ...config, extra: true }), { mode: 0o600 });
  await assert.rejects(startMsd({ root: dir, startBroker: broker.start }), /INVALID_CONFIG/);
  await writeDaemonConfig(paths.config, config); await chmod(paths.config, 0o644);
  await assert.rejects(startMsd({ root: dir, startBroker: broker.start }), /INVALID_CONFIG/);
  assert.equal(broker.state.helper, undefined);
});
