// INPUT: Temp HOME/source fixtures, a stub Claude step and a recording fake launchctl.
// OUTPUT: Dry-run no-write, byte-exact install/uninstall round trip, user-edit preservation, conflict and rollback regressions,
//         and DSH beacon writes at fixed removal points (bounded like production; over the retry limit stays recoverable).
// POS: Offline installer tests; never touches the real HOME, launchd, Claude or DSH.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, lstat, mkdir, readFile, rename, rm, rmdir, writeFile, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CliError, exitCodeFor } from '../../src/cli/errors.ts';
import { BUNDLE_EXCLUDES, BUNDLE_INCLUDES, planInstall, describePlan, type ClaudeStep, type InstallEnv } from '../../src/cli/install.ts';
import { applyInstall } from '../../src/cli/install-apply.ts';
import { applyUninstall, describeUninstall, loadManifest } from '../../src/cli/uninstall.ts';
import { revertRecord } from '../../src/cli/revert.ts';
import { DESKTOP_PATCH, FAKE_PINS, STUB_CLAUDE, makeEnv, makeHome, makeSource, recordingLaunchctl, snapshotTree } from './install-fixture.ts';

test('the bundle carries the root package.json and the ms-dsh package, whose own manifest is the one DSH reads', async () => {
  assert.ok(BUNDLE_INCLUDES.includes('package.json') && BUNDLE_INCLUDES.includes('plugins/ms-dsh'));
  const root = new URL('../../', import.meta.url).pathname;
  let dir = join(root, 'plugins', 'ms-dsh');
  while (!(await stat(join(dir, 'package.json')).then(() => true, () => false))) dir = join(dir, '..');
  assert.equal(join(dir, 'package.json'), join(root, 'plugins', 'ms-dsh', 'package.json'));
});

// The Claude SDK is a devDependency used only by the metadata worker, so neither the SDK nor that worker ships.
test('the bundle built from this checkout carries no Claude SDK, no file importing it and neither metadata file', async () => {
  const home = await makeHome();
  try {
    const root = new URL('../../', import.meta.url).pathname;
    const plan = await planInstall(makeEnv(home, { root, node: process.execPath }));
    const relatives = plan.sources.map(file => file.relative);
    assert.ok(relatives.includes('src/daemon/main.ts') && relatives.includes('plugins/ms-dsh/index.mjs'));
    assert.ok(relatives.includes('node_modules/@deepseek-ai/dsh-tools/package.json'), 'the DSH plugin runtime dependency, from npm-shrinkwrap.json');
    assert.deepEqual(BUNDLE_EXCLUDES, ['src/adapters/claude/metadata-worker.mjs', 'src/adapters/claude/metadata.ts']);
    for (const excluded of BUNDLE_EXCLUDES) assert.ok(!relatives.includes(excluded), excluded);
    assert.ok(!relatives.some(path => path.startsWith('node_modules/@anthropic-ai/')), 'no Anthropic SDK package');
    for (const file of plan.sources.filter(item => /\.(?:[cm]?js|ts)$/.test(item.relative))) {
      assert.doesNotMatch(await readFile(file.source, 'utf8'), /@anthropic-ai\/claude-agent-sdk/, file.relative);
    }
  } finally { await rm(home, { recursive: true, force: true }); }
});

async function fixture(claude: ClaudeStep = STUB_CLAUDE): Promise<{ home: string; env: InstallEnv; cleanup: () => Promise<void> }> {
  const home = await makeHome();
  const source = await makeSource();
  const env = makeEnv(home, source, claude);
  return { home, env, cleanup: async () => { await rm(home, { recursive: true, force: true }); await rm(source.root, { recursive: true, force: true }); } };
}

function uninstallDeps(env: InstallEnv) {
  const fake = recordingLaunchctl();
  return { fake, deps: { paths: env.paths, launchctl: fake.launchctl, uid: 501, dshPnpm: env.dshPnpm, claudeCli: env.claudeCli, codexCli: env.codexCli } };
}

test('dry run plans every write but leaves HOME byte-identical', async () => {
  const { home, env, cleanup } = await fixture();
  try {
    const before = await snapshotTree(home);
    const text = describePlan(await planInstall(env), env.paths);
    assert.deepEqual(await snapshotTree(home), before);
    for (const fragment of ['dry run, nothing written', env.paths.root, env.paths.launchAgent, env.paths.fallback,
      `pin python ${FAKE_PINS.python.path} (aaaaaaaaaaaa)`,
      'DSH pnpm add link:', 'restart DSH', 'claude step (stub)', 'Library/LaunchAgents']) {
      assert.ok(text.includes(fragment), fragment);
    }
  } finally { await cleanup(); }
});

test('install writes the pinned bundle and entries; uninstall restores HOME byte for byte', async () => {
  const { home, env, cleanup } = await fixture();
  try {
    const before = await snapshotTree(home);
    await applyInstall(await planInstall(env), env);
    const manifest = await loadManifest(env.paths);
    assert.equal(manifest.state, 'installed');
    const bundle = manifest.bundle!.path;
    assert.deepEqual((await readdir(bundle)).sort(), ['bundle.json', 'node_modules', 'package.json', 'plugins', 'runtime', 'src']);
    assert.deepEqual(await readdir(join(bundle, 'node_modules')), ['prod']);
    assert.equal((await stat(join(bundle, 'runtime/node'))).mode & 0o777, 0o500);
    assert.equal((await stat(env.paths.root)).mode & 0o777, 0o700);
    const plist = await readFile(env.paths.launchAgent, 'utf8');
    assert.ok(plist.includes(`<string>${join(bundle, 'runtime/node')}</string>`) && plist.includes(`${bundle}/src/daemon/main.ts`));
    assert.equal(env.paths.fallback, join(env.paths.root, 'bin', 'ms'));
    assert.equal(await readFile(env.paths.fallback, 'utf8'), `#!/bin/sh\nexec '${bundle}/runtime/node' '${bundle}/src/cli/entry.ts' "$@"\n`);
    assert.equal((await stat(env.paths.fallback)).mode & 0o777, 0o700);
    await assert.rejects(stat(join(home, '.local')), { code: 'ENOENT' }, 'no ~/.local/bin shim: ms comes from npm');
    assert.equal(await readFile(join(home, '.dsh/profiles/desktop/cordis.patch.yml'), 'utf8'), DESKTOP_PATCH);
    assert.equal(await readFile(join(home, '.dsh/cordis.patch.yml'), 'utf8'), '- id: relay-codex-host\n  config: {}\n');
    assert.equal(await readFile(join(home, '.dsh/profiles/web/cordis.patch.yml'), 'utf8'), '[]\n');
    const { fake, deps } = uninstallDeps(env);
    assert.match(describeUninstall(manifest, env.paths, false), /remove agent-message-switchboard-dsh from DSH profile/);
    await applyUninstall(manifest, deps, false);
    assert.deepEqual(fake.calls, [['bootout', 'gui/501/local.agent-message-switchboard.msd'], ['print', 'gui/501/local.agent-message-switchboard.msd']]);
    assert.deepEqual(await snapshotTree(home), before);
  } finally { await cleanup(); }
});

test('later user edits survive uninstall; only ms items are removed', async () => {
  const { home, env, cleanup } = await fixture();
  try {
    await applyInstall(await planInstall(env), env);
    const path = join(home, '.dsh/profiles/desktop/cordis.patch.yml');
    await writeFile(path, (await readFile(path, 'utf8')) + '- id: ui-chat\n  config: {}\n');
    await applyUninstall(await loadManifest(env.paths), uninstallDeps(env).deps, false);
    assert.equal(await readFile(path, 'utf8'), DESKTOP_PATCH + '- id: ui-chat\n  config: {}\n');
    await assert.rejects(stat(env.paths.root), { code: 'ENOENT' });
  } finally { await cleanup(); }
});

test('a user-modified ms file is a conflict: kept, root and backups kept, rerun succeeds after the user resolves it', async () => {
  const { home, env, cleanup } = await fixture();
  try {
    const before = await snapshotTree(home);
    await applyInstall(await planInstall(env), env);
    await writeFile(env.paths.launchAgent, 'mine');
    await assert.rejects(applyUninstall(await loadManifest(env.paths), uninstallDeps(env).deps, false), { code: 'UNINSTALL_CONFLICT' });
    assert.equal(await readFile(env.paths.launchAgent, 'utf8'), 'mine');
    const remaining = await loadManifest(env.paths);
    assert.equal(remaining.state, 'conflict');
    assert.deepEqual(remaining.records.map(record => record.kind), ['mkdir', 'create']);
    await rm(env.paths.launchAgent);
    await applyUninstall(remaining, uninstallDeps(env).deps, false);
    const after = await snapshotTree(home);
    assert.deepEqual(after, before);
  } finally { await cleanup(); }
});

test('core preconditions fail before any write; a missing DSH profile skips only DSH', async () => {
  const { home, env, cleanup } = await fixture();
  try {
    await applyInstall(await planInstall(env), env);
    await assert.rejects(planInstall(env), { code: 'INSTALL_ALREADY_PRESENT' });
    await applyUninstall(await loadManifest(env.paths), uninstallDeps(env).deps, false);
    await mkdir(join(home, 'Library/LaunchAgents'), { recursive: true });
    await writeFile(env.paths.launchAgent, 'other');
    const before = await snapshotTree(home);
    await assert.rejects(planInstall(env), { code: 'INSTALL_PRECONDITION_FAILED' });
    await rm(env.paths.launchAgent);
    await rm(join(home, '.dsh/profiles/desktop'), { recursive: true });
    assert.match(describePlan(await planInstall(env), env.paths), /\n {2}dsh: skipped \(DSH desktop profile missing\); manual install: docs\/user-guide\.md#manual-dsh/);
    assert.deepEqual(Object.keys(await snapshotTree(home)).length, Object.keys(before).length - 7, 'the LaunchAgent and the six desktop profile entries');
    await assert.rejects(loadManifest(env.paths), { code: 'NOT_INSTALLED' });
  } finally { await cleanup(); }
});

// The copied Node must run before anything else is written; a copy that does not is rolled back with the rest.
test('a bundled Node that does not run fails install before the LaunchAgent and rolls everything back', async () => {
  const { home, env, cleanup } = await fixture();
  try {
    await writeFile(env.nodePath, '#!/bin/sh\nexit 3\n');
    const before = await snapshotTree(home);
    await assert.rejects(applyInstall(await planInstall(env), env), (error: CliError) => error.code === 'INSTALL_FAILED'
      && /INSTALL_FAILED: the bundled Node does not run/.test(error.detail ?? ''));
    assert.deepEqual(await snapshotTree(home), before);
  } finally { await cleanup(); }
});

// Install runs from a throwaway staging copy of the package, so nothing it writes may point back at its source.
test('nothing install writes records the source it ran from', async () => {
  const { home, env, cleanup } = await fixture();
  try {
    await applyInstall(await planInstall(env), env);
    const written = await snapshotTree(home);
    const files = Object.entries(written).filter(([, entry]) => entry.startsWith('file')).map(([path]) => join(home, path));
    for (const file of files) assert.ok(!(await readFile(file, 'utf8')).includes(env.sourceRoot), file);
  } finally { await cleanup(); }
});

// msd's Node is a copy of whatever Node ran install; no identity check may depend on it (only Python is pinned).
test('the copied Node is pinned nowhere: config.json pins Python only and no identity code names the bundle runtime', async () => {
  const { env, cleanup } = await fixture();
  try {
    await applyInstall(await planInstall(env), env);
    const config = JSON.parse(await readFile(join(env.paths.root, 'config.json'), 'utf8'));
    assert.deepEqual(config.python, FAKE_PINS.python);
    assert.deepEqual(config.claude, { wrapperPins: [] });
    assert.ok(!JSON.stringify(config).includes('runtime/node'));
    const root = new URL('../../', import.meta.url).pathname;
    for (const file of ['src/daemon/claude-identity.ts', 'src/bridge/native/macos_identity.py', 'src/bridge/native/broker_identity.py',
      'src/bridge/claude-ancestry.ts', 'src/cli/pins.ts']) {
      assert.doesNotMatch(await readFile(join(root, file), 'utf8'), /runtime\/node|process\.execPath/, file);
    }
  } finally { await cleanup(); }
});

test('failure mid-install rolls every write back', async () => {
  const failing: ClaudeStep = { lines: [], apply: async () => { throw new Error('boom'); } };
  const { home, env, cleanup } = await fixture(failing);
  try {
    const before = await snapshotTree(home);
    await assert.rejects(applyInstall(await planInstall(env), env), { code: 'INSTALL_FAILED' });
    assert.deepEqual(await snapshotTree(home), before);
  } finally { await cleanup(); }
});

test('a rollback that meets a revert conflict keeps the private root, backups and the unresolved record for ms uninstall', async () => {
  let plist = '';
  const failing: ClaudeStep = { lines: [], apply: async () => {
    await writeFile(plist, 'mine');
    throw new Error('boom');
  } };
  const { home, env, cleanup } = await fixture(failing);
  plist = env.paths.launchAgent;
  try {
    const before = await snapshotTree(home);
    await assert.rejects(applyInstall(await planInstall(env), env), (error: CliError) => error.code === 'INSTALL_FAILED'
      && /CONFLICT .*LaunchAgents/.test(error.detail ?? '') && error.detail!.includes(`private root kept with backups: ${env.paths.root}`)
      && error.detail!.includes('ms uninstall'));
    assert.equal(await readFile(plist, 'utf8'), 'mine');
    assert.ok((await readdir(env.paths.backups)).some(name => name.endsWith('package.json')));
    const remaining = await loadManifest(env.paths);
    assert.equal(remaining.state, 'conflict');
    assert.deepEqual(remaining.records.map(record => record.kind), ['mkdir', 'create']);
    await assert.rejects(stat(join(home, '.local')), { code: 'ENOENT' });
    await assert.rejects(planInstall(env), { code: 'INSTALL_ALREADY_PRESENT' });
    await rm(plist);
    await applyUninstall(remaining, uninstallDeps(env).deps, false);
    assert.deepEqual(await snapshotTree(home), before);
  } finally { await cleanup(); }
});

test('a rollback whose revert throws keeps the private root and that record instead of dropping the backups', async () => {
  let library = '';
  const failing: ClaudeStep = { lines: [], apply: async () => { await chmod(library, 0o500); throw new Error('boom'); } };
  const { home, env, cleanup } = await fixture(failing);
  library = join(home, 'Library');
  try {
    const before = await snapshotTree(home);
    await assert.rejects(applyInstall(await planInstall(env), env), (error: CliError) => error.code === 'INSTALL_FAILED'
      && error.detail!.includes('CONFLICT mkdir record: revert failed') && error.detail!.includes(env.paths.root));
    await chmod(library, 0o755);
    const remaining = await loadManifest(env.paths);
    assert.equal(remaining.state, 'conflict');
    assert.deepEqual(remaining.records, [{ kind: 'mkdir', path: join(library, 'LaunchAgents') }]);
    await applyUninstall(remaining, uninstallDeps(env).deps, false);
    assert.deepEqual(await snapshotTree(home), before);
  } finally { await chmod(library, 0o755); await cleanup(); }
});

test('a held DSH profile lock aborts install and leaves no trace', async () => {
  const { home, env, cleanup } = await fixture();
  try {
    const lock = join(home, '.dsh/profiles/desktop/package.json.lock');
    await writeFile(lock, '999');
    const before = await snapshotTree(home);
    await assert.rejects(applyInstall(await planInstall(env), env), { code: 'INSTALL_PRECONDITION_FAILED' });
    assert.deepEqual(await snapshotTree(home), before);
  } finally { await cleanup(); }
});

test('install writes msd config.json with discovered pins and default switches', async () => {
  const { env, cleanup } = await fixture();
  try {
    await applyInstall(await planInstall(env), env);
    const path = join(env.paths.root, 'config.json');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
      schemaVersion: 4, python: FAKE_PINS.python, claude: { wrapperPins: [] },
      autoRegister: { claude: false, dsh: false, codex: false }, autoRegisterProjects: [],
      replyMode: { claude: 'direct', dsh: 'direct', codex: 'direct' },
      actPreset: { claude: 'workspace-write', dsh: 'workspace-write', codex: 'workspace-write' }, linkBudget: { windowSeconds: 600, maxPushes: 30 },
    });
    assert.deepEqual(Object.keys(JSON.parse(await readFile(path, 'utf8'))),
      ['schemaVersion', 'python', 'claude', 'autoRegister', 'autoRegisterProjects', 'replyMode', 'actPreset', 'linkBudget']);
  } finally { await cleanup(); }
});

test('--keep-data keeps state/ and config.json; a later install reuses them and a plain uninstall removes them with the root', async () => {
  const { home, env, cleanup } = await fixture();
  try {
    const before = await snapshotTree(home);
    await applyInstall(await planInstall(env), env);
    await mkdir(join(env.paths.root, 'state'), { mode: 0o700 });
    await writeFile(join(env.paths.root, 'state', 'directory.json'), '{"aliases":{}}\n');
    assert.match(describeUninstall(await loadManifest(env.paths), env.paths, true), /except state\/ and config\.json/);
    await applyUninstall(await loadManifest(env.paths), uninstallDeps(env).deps, true);
    assert.deepEqual((await readdir(env.paths.root)).sort(), ['config.json', 'state']);
    assert.equal(await readFile(join(env.paths.root, 'state', 'directory.json'), 'utf8'), '{"aliases":{}}\n');
    const plan = await planInstall(env);
    assert.equal(plan.rootExisted, true);
    assert.match(describePlan(plan, env.paths), /reuse private root \(kept state\/\)/);
    await applyInstall(plan, env);
    assert.equal(await readFile(join(env.paths.root, 'state', 'directory.json'), 'utf8'), '{"aliases":{}}\n');
    await applyUninstall(await loadManifest(env.paths), uninstallDeps(env).deps, false);
    assert.deepEqual(await snapshotTree(home), before);
  } finally { await cleanup(); }
});

test('a private root with anything besides state/ blocks install; failed install over kept state keeps the state', async () => {
  const failing: ClaudeStep = { lines: [], apply: async () => { throw new Error('boom'); } };
  const { env, cleanup } = await fixture(failing);
  try {
    await mkdir(join(env.paths.root, 'state'), { recursive: true, mode: 0o700 });
    await writeFile(join(env.paths.root, 'state', 'directory.json'), 'kept');
    await assert.rejects(applyInstall(await planInstall(env), env), { code: 'INSTALL_FAILED' });
    assert.deepEqual(await readdir(env.paths.root), ['state']);
    await writeFile(join(env.paths.root, 'stray'), 'x');
    await assert.rejects(planInstall(env), { code: 'INSTALL_PRECONDITION_FAILED' });
  } finally { await cleanup(); }
});

test('uninstall keeps records it cannot safely revert: held DSH lock, vanished plugin tree, corrupt manifest', async () => {
  const { home, env, cleanup } = await fixture();
  try {
    await applyInstall(await planInstall(env), env);
    const lock = join(home, '.dsh/profiles/desktop/package.json.lock');
    await writeFile(lock, '999');
    await assert.rejects(applyUninstall(await loadManifest(env.paths), uninstallDeps(env).deps, false),
      (error: { code: string; detail: string }) => error.code === 'UNINSTALL_CONFLICT' && error.detail.includes('dsh profile is locked'));
    assert.deepEqual((await loadManifest(env.paths)).records.map(record => record.kind), ['dsh-bundle']);
    await rm(lock);
    await applyUninstall(await loadManifest(env.paths), uninstallDeps(env).deps, false);
    const dsh = '{"kind":"dsh-bundle","packageJson":{"path":"/p/package.json"},"pnpmLock":{"path":"/p/pnpm-lock.yaml"},"lockPath":"/p/package.json.lock","patchPath":"/p/cordis.patch.yml","link":"/p/node_modules/x","packageName":"x"';
    for (const text of ['not json', '{"schemaVersion":2,"state":"installed","records":[]}', '{"schemaVersion":1,"state":"installed","records":[{"kind":"tree","path":"rel"}]}',
      `{"schemaVersion":1,"state":"installed","records":[${dsh}}]}`]) {
      await mkdir(env.paths.installDir, { recursive: true });
      await writeFile(env.paths.manifest, text);
      await assert.rejects(loadManifest(env.paths), { code: 'MANIFEST_INVALID' });
    }
    await writeFile(env.paths.manifest, `{"schemaVersion":1,"state":"installed","records":[${dsh},"target":"/b/plugins/ms-dsh"}]}`);
    assert.equal((await loadManifest(env.paths)).records.length, 1);
    const vanished = { kind: 'tree', path: join(home, 'gone'), captured: true, files: [] } as const;
    assert.deepEqual(await revertRecord(vanished, { dshPnpm: env.dshPnpm, claudeCli: env.claudeCli, codexCli: env.codexCli }), { ok: true, note: `${join(home, 'gone')}: already absent` });
  } finally { await cleanup(); }
});

test('uninstall after ms daemon stop: a bootout that finds no service is confirmed with print and the revert proceeds', async () => {
  for (const bootoutCode of [3, 113]) {
    const { home, env, cleanup } = await fixture();
    try {
      const before = await snapshotTree(home);
      await applyInstall(await planInstall(env), env);
      const calls: string[][] = [];
      const launchctl = async (args: readonly string[]) => {
        calls.push([...args]);
        return { code: args[0] === 'bootout' ? bootoutCode : 113, stdout: '' };
      };
      await applyUninstall(await loadManifest(env.paths), { paths: env.paths, launchctl, uid: 501, dshPnpm: env.dshPnpm, claudeCli: env.claudeCli, codexCli: env.codexCli }, false);
      assert.deepEqual(calls, [['bootout', 'gui/501/local.agent-message-switchboard.msd'], ['print', 'gui/501/local.agent-message-switchboard.msd']]);
      assert.deepEqual(await snapshotTree(home), before, `bootout ${bootoutCode}`);
    } finally { await cleanup(); }
  }
});

test('uninstall stops before reverting anything when bootout fails and the service is still loaded', async () => {
  const { env, cleanup } = await fixture();
  try {
    await applyInstall(await planInstall(env), env);
    const installed = await snapshotTree(env.paths.home);
    const launchctl = async (args: readonly string[]) => ({ code: args[0] === 'bootout' ? 5 : 0, stdout: 'state = running\npid = 7\n' });
    await assert.rejects(applyUninstall(await loadManifest(env.paths), { paths: env.paths, launchctl, uid: 501, dshPnpm: env.dshPnpm, claudeCli: env.claudeCli, codexCli: env.codexCli }, false),
      { code: 'LAUNCHD_FAILED', detail: 'bootout exit 5' });
    assert.deepEqual(await snapshotTree(env.paths.home), installed);
  } finally { await cleanup(); }
});

test('removing the private root retries when the DSH plugin re-creates run/ with its beacon mid-removal', async () => {
  const { home, env, cleanup } = await fixture();
  try {
    const before = await snapshotTree(home);
    await applyInstall(await planInstall(env), env);
    const seen: string[] = [];
    const remove = async (path: string) => {
      seen.push(path);
      if (path === env.paths.root && seen.filter(item => item === env.paths.root).length === 1) {
        await mkdir(join(env.paths.root, 'run'), { recursive: true, mode: 0o700 });
        await writeFile(join(env.paths.root, 'run', 'dsh-plugin.json'), '{"state":"failed"}', { mode: 0o600 });
        throw Object.assign(new Error('directory not empty'), { code: 'ENOTEMPTY' });
      }
      await rm(path, { recursive: true, force: true });
    };
    await applyUninstall(await loadManifest(env.paths), { ...uninstallDeps(env).deps, remove }, false);
    assert.ok(seen.filter(item => item === env.paths.root).length >= 2);
    assert.ok(seen.indexOf(env.paths.installDir) > seen.findIndex(item => item.startsWith(env.paths.bundles)));
    assert.deepEqual(await snapshotTree(home), before);
  } finally { await cleanup(); }
});

test('a private root that cannot be removed fails with a fixed code and keeps the manifest for a rerun', async () => {
  const { home, env, cleanup } = await fixture();
  try {
    const before = await snapshotTree(home);
    await applyInstall(await planInstall(env), env);
    const stuck = async (path: string) => {
      if (path === env.paths.bundles) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      await rm(path, { recursive: true, force: true });
    };
    await assert.rejects(applyUninstall(await loadManifest(env.paths), { ...uninstallDeps(env).deps, remove: stuck }, false),
      (error: { code: string; detail: string }) => error.code === 'ROOT_REMOVE_FAILED' && error.detail.includes('EBUSY'));
    assert.equal((await loadManifest(env.paths)).state, 'installed');
    await applyUninstall(await loadManifest(env.paths), uninstallDeps(env).deps, false);
    assert.deepEqual(await snapshotTree(home), before);
  } finally { await cleanup(); }
});

// As in src/adapters/dsh/plugin-beacon.ts, the plugin rewrites run/dsh-plugin.json only when its snapshot changes, so after bootout
// it writes at most once and fails at most two removal attempts, below REMOVE_ATTEMPTS (5); the tests place writes at fixed points.
async function beaconWrite(root: string, seq: number): Promise<void> {
  const run = join(root, 'run');
  const temporary = join(run, `.dsh-plugin-${seq}.tmp`);
  try {
    await mkdir(run, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    await writeFile(temporary, '{"state":"failed"}\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, join(run, 'dsh-plugin.json'));
  } catch { await rm(temporary, { force: true }); }
}

// rm -r with a hook between "children removed" and "rmdir the directory", the window where a write fails a removal.
function steppedRemove(between: (path: string) => Promise<void>, removed: (path: string) => Promise<void>) {
  const removeTree = async (path: string): Promise<void> => {
    const info = await lstat(path).catch(() => null);
    if (info === null) return;
    if (info.isDirectory()) {
      for (const name of await readdir(path)) await removeTree(join(path, name));
      await between(path);
      await rmdir(path);
    } else await rm(path);
  };
  return async (path: string) => { await removeTree(path); await removed(path); };
}

test('beacon writes at fixed points of the removal, fewer than the retry limit, still remove the private root', async () => {
  const { home, env, cleanup } = await fixture();
  try {
    const before = await snapshotTree(home);
    await applyInstall(await planInstall(env), env);
    const run = join(env.paths.root, 'run');
    let writes = 0;
    await beaconWrite(env.paths.root, writes);
    const failed: string[] = [];
    const fired = new Set<string>();
    const once = async (key: string) => {
      if (fired.has(key)) return;
      fired.add(key);
      writes += 1;
      await beaconWrite(env.paths.root, writes);
    };
    const remove = steppedRemove(async path => {
      if (path === run || path === env.paths.root) await once(`before rmdir ${path}`);
    }, async path => { if (path === run) await once('rebuild run/'); });
    const counting = async (path: string) => {
      try { await remove(path); } catch (error) { failed.push(`${path}: ${(error as NodeJS.ErrnoException).code}`); throw error; }
    };
    await applyUninstall(await loadManifest(env.paths), { ...uninstallDeps(env).deps, remove: counting }, false);
    assert.equal(writes, 3);
    assert.deepEqual(failed.map(item => item.replace(/: E(NOTEMPTY|EXIST)$/, '')), [run, env.paths.root]);
    await assert.rejects(stat(env.paths.root), { code: 'ENOENT' });
    assert.deepEqual(await snapshotTree(home), before);
  } finally { await cleanup(); }
});

for (const where of ['run', 'root'] as const) {
  test(`a beacon write in every removal attempt of ${where} fails with ROOT_REMOVE_FAILED, keeps the manifest and a rerun finishes`, async () => {
    const { home, env, cleanup } = await fixture();
    try {
      const before = await snapshotTree(home);
      await applyInstall(await planInstall(env), env);
      const manifest = await loadManifest(env.paths);
      await beaconWrite(env.paths.root, 0);
      const target = where === 'run' ? join(env.paths.root, 'run') : env.paths.root;
      let writes = 0;
      const remove = steppedRemove(async path => {
        if (path === target) { writes += 1; await beaconWrite(env.paths.root, writes); }
      }, async () => undefined);
      await assert.rejects(applyUninstall(manifest, { ...uninstallDeps(env).deps, remove }, false), (error: CliError) =>
        error.code === 'ROOT_REMOVE_FAILED' && exitCodeFor(error.code) === 5 && error.detail!.startsWith(`${target}: `));
      assert.equal(writes, 5);
      assert.deepEqual(await loadManifest(env.paths), manifest);
      await applyUninstall(await loadManifest(env.paths), uninstallDeps(env).deps, false);
      assert.deepEqual(await snapshotTree(home), before);
    } finally { await cleanup(); }
  });
}

test('--keep-data followed by a plugin beacon still lets install reuse the kept root', async () => {
  const { home, env, cleanup } = await fixture();
  try {
    const before = await snapshotTree(home);
    await applyInstall(await planInstall(env), env);
    await applyUninstall(await loadManifest(env.paths), uninstallDeps(env).deps, true);
    await mkdir(join(env.paths.root, 'run'), { mode: 0o700 });
    await writeFile(join(env.paths.root, 'run', 'dsh-plugin.json'), '{"state":"failed"}', { mode: 0o600 });
    const plan = await planInstall(env);
    assert.equal(plan.rootExisted, true);
    await applyInstall(plan, env);
    await applyUninstall(await loadManifest(env.paths), uninstallDeps(env).deps, false);
    assert.deepEqual(await snapshotTree(home), before);
  } finally { await cleanup(); }
});
