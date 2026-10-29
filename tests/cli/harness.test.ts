// INPUT: Temp HOME with DSH, Claude and Codex fixtures, a fake DSH pnpm and a fake Claude plugin generator, driven through runCli.
// OUTPUT: Per-harness regressions: a precondition skips only that harness (exit 0), records carry their harness, install --harness
//         (fresh, reinstall, DSH alone beside Claude and Codex after a hand-removed leftover link, precondition failure, rollback)
//         and uninstall --harness (only that harness, conflicts, not installed).
// POS: Offline tests for the client form (core once, each harness through its own step); no real HOME, launchd or hosts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { planClaudeMarketplaceStep, type PluginGenerator } from '../../src/cli/claude-marketplace-step.ts';
import { DSH_PACKAGE } from '../../src/cli/dsh-bundle.ts';
import { createHandlers } from '../../src/cli/handlers.ts';
import { runCli } from '../../src/cli/main.ts';
import { loadManifest } from '../../src/cli/uninstall.ts';
import { DESKTOP_PATCH, FAKE_PINS, fakeDshPnpm, makeEnv, makeHome, makeSource, recordingLaunchctl, snapshotTree } from './install-fixture.ts';

const CONFIG = 'model = "gpt"\n';
const HOOKS = '{\n  "hooks": {}\n}\n';
const generator: PluginGenerator = async ({ directory, pythonPath }) => {
  await mkdir(join(directory, '.claude-plugin'), { recursive: true, mode: 0o700 });
  await writeFile(join(directory, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'ms-local', pythonPath }), { mode: 0o600 });
};

async function fixture(options: { generate?: PluginGenerator } = {}) {
  const home = await makeHome();
  const source = await makeSource();
  await mkdir(join(source.root, 'src/adapters/codex'), { recursive: true });
  await writeFile(join(source.root, 'src/adapters/codex/mcp-main.ts'), '// adapter\n');
  await mkdir(join(home, '.codex', '.tmp', 'marketplaces'), { recursive: true });
  await mkdir(join(home, '.codex', 'tmp', 'arg0-macos'), { recursive: true });
  await writeFile(join(home, '.codex/config.toml'), CONFIG);
  await writeFile(join(home, '.codex/hooks.json'), HOOKS);
  const fake = fakeDshPnpm();
  const base = makeEnv(home, source, undefined, fake.pnpm);
  const env = { ...base, planClaude: (o: { pythonPath: string }) =>
    planClaudeMarketplaceStep({ paths: base.paths, generate: options.generate ?? generator, claude: base.claudeCli }, o) };
  const handlers = createHandlers({
    env, launchctl: recordingLaunchctl().launchctl, uid: 501, controlTimeoutMs: 500, readyTimeoutMs: 0, sleep: async () => undefined,
    ui: { open: async () => {}, untilStopped: () => new Promise(() => {}) },
    repin: { paths: env.paths, now: () => 'now', discoverPins: async () => FAKE_PINS, generate: generator, reload: async () => ({}), restart: async () => true },
  });
  const run = async (argv: string[]): Promise<[number, string, string]> => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(argv, { io: { out: text => out.push(text), err: text => err.push(text) }, cwd: home, paths: env.paths, controlTimeoutMs: 500, handlers });
    return [code, out.join('\n'), err.join('\n')];
  };
  const profile = join(home, '.dsh', 'profiles', 'desktop');
  const harnessesOf = async () => (await loadManifest(env.paths)).records.map(record => `${record.kind}:${record.harness ?? 'core'}`);
  const cleanup = async () => { await rm(home, { recursive: true, force: true }); await rm(source.root, { recursive: true, force: true }); };
  return { home, env, fake, run, profile, harnessesOf, cleanup };
}

test('install installs every harness, tags each record with its harness and prints one result line per harness', async () => {
  const { run, harnessesOf, cleanup } = await fixture();
  try {
    const [code, out] = await run(['install']);
    assert.equal(code, 0);
    assert.match(out, /\ndsh: installed \(restart DSH once so it loads agent-message-switchboard-dsh\)/);
    assert.match(out, /\nclaude-code: installed \(/);
    assert.match(out, /\ncodex: installed \(/);
    assert.deepEqual(await harnessesOf(), ['mkdir:core', 'create:core',
      'dsh-bundle:dsh', 'tree:claude-code', 'claude-plugin:claude-code', 'tree:codex', 'codex-plugin:codex']);
  } finally { await cleanup(); }
});

test('a harness whose preconditions fail is skipped with exit 0, a reason and the manual install guide', async () => {
  const { run, profile, harnessesOf, cleanup } = await fixture();
  try {
    await writeFile(join(profile, 'cordis.patch.yml'), `${DESKTOP_PATCH}- id: ms-dsh-client\n  name: /old/index.mjs\n`);
    const [dryCode, dry] = await run(['install', '--dry-run']);
    assert.equal(dryCode, 0);
    assert.match(dry, /\n {2}dsh: skipped \(.*still names ms-dsh-client.*\); manual install: docs\/user-guide\.md#manual-dsh, plugin directory \/.*\/plugins\/ms-dsh/);
    const [code, out] = await run(['install']);
    assert.equal(code, 0);
    assert.match(out, /\ndsh: skipped \(/);
    assert.match(out, /\nclaude-code: installed/);
    assert.ok(!(await harnessesOf()).some(entry => entry.endsWith(':dsh')));
    const [removed, removedOut] = await run(['uninstall']);
    assert.equal(removed, 0);
    assert.doesNotMatch(removedOut, /restart DSH/);
  } finally { await cleanup(); }
});

test('uninstall --harness reverts only that harness; the core and the other harnesses stay; a full uninstall then restores HOME', async () => {
  const { home, env, run, profile, harnessesOf, cleanup } = await fixture();
  try {
    const before = await snapshotTree(home);
    const beforeProfile = await snapshotTree(profile);
    assert.equal((await run(['install']))[0], 0);
    const [dryCode, dry] = await run(['uninstall', '--harness', 'dsh', '--dry-run']);
    assert.equal(dryCode, 0);
    assert.match(dry, /^ms uninstall plan for dsh \(dry run, nothing written\):\n {2}remove agent-message-switchboard-dsh from DSH profile/);
    const [code, out] = await run(['uninstall', '--harness', 'dsh']);
    assert.equal(code, 0);
    assert.match(out, /^ms uninstalled dsh\n/);
    assert.match(out, /restart DSH/);
    assert.deepEqual(await snapshotTree(profile), beforeProfile);
    assert.ok(!(await harnessesOf()).some(entry => entry.endsWith(':dsh')));
    for (const path of [env.paths.launchAgent, env.paths.fallback, join(env.paths.root, 'claude-marketplace')]) await stat(path);
    assert.deepEqual(await run(['uninstall', '--harness', 'dsh']), [5, '', 'ms: NOT_INSTALLED: dsh was not installed by ms']);
    assert.equal((await run(['uninstall']))[0], 0);
    assert.deepEqual(await snapshotTree(home), before);
  } finally { await cleanup(); }
});

test('install --harness adds a harness back, reinstalls an installed one and needs the core', async () => {
  const { home, fake, run, harnessesOf, cleanup } = await fixture();
  try {
    assert.deepEqual(await run(['install', '--harness', 'dsh']), [5, '', 'ms: NOT_INSTALLED']);
    const before = await snapshotTree(home);
    assert.equal((await run(['install']))[0], 0);
    assert.equal((await run(['uninstall', '--harness', 'dsh']))[0], 0);
    const [dryCode, dry] = await run(['install', '--harness', 'dsh', '--dry-run']);
    assert.equal(dryCode, 0);
    assert.match(dry, /^ms install plan for dsh \(dry run, nothing written\):\n {2}dsh:\n {4}in .* run DSH pnpm add link:/);
    const [code, out] = await run(['install', '--harness', 'dsh']);
    assert.equal(code, 0);
    assert.match(out, /^ms installed dsh\ndsh: installed \(restart DSH once/);
    assert.equal((await harnessesOf()).filter(entry => entry === 'dsh-bundle:dsh').length, 1);
    const [reCode, reDry] = await run(['install', '--harness', 'dsh', '--dry-run']);
    assert.equal(reCode, 0);
    assert.match(reDry, /reinstall: first revert\n {4}remove agent-message-switchboard-dsh/);
    assert.equal((await run(['install', '--harness', 'dsh']))[0], 0);
    assert.deepEqual(fake.calls.map(call => call[0]), ['add', 'remove', 'add', 'remove', 'add']);
    assert.equal((await harnessesOf()).filter(entry => entry === 'dsh-bundle:dsh').length, 1);
    assert.equal((await run(['uninstall']))[0], 0);
    assert.deepEqual(await snapshotTree(home), before);
  } finally { await cleanup(); }
});

test('a leftover link outside the ledger skips only DSH and stays refused; once removed by hand, install --harness dsh adds DSH beside Claude and Codex', async () => {
  const { home, run, profile, harnessesOf, cleanup } = await fixture();
  try {
    const link = join(profile, 'node_modules', DSH_PACKAGE);
    await symlink('../../../../../Library/Application Support/agent-message-switchboard/bundles/0000000000000000/plugins/ms-dsh', link);
    const leftover = relative(home, join(await realpath(dirname(link)), DSH_PACKAGE));
    const { [leftover]: leftoverEntry, ...before } = await snapshotTree(home);
    assert.match(leftoverEntry, /^link /);
    const [code, out] = await run(['install']);
    assert.equal(code, 0);
    assert.ok(out.includes(`\ndsh: skipped (already exists: ${link})`), out);
    assert.match(out, /\nclaude-code: installed[\s\S]*\ncodex: installed/);
    const [refused, , err] = await run(['install', '--harness', 'dsh']);
    assert.equal(refused, 5);
    assert.ok(err.startsWith(`ms: INSTALL_PRECONDITION_FAILED: already exists: ${link}`), err);
    await rm(link);
    const [added, addedOut] = await run(['install', '--harness', 'dsh']);
    assert.equal(added, 0);
    assert.match(addedOut, /^ms installed dsh\ndsh: installed \(restart DSH once/);
    assert.deepEqual((await harnessesOf()).filter(entry => !entry.endsWith(':core')),
      ['tree:claude-code', 'claude-plugin:claude-code', 'tree:codex', 'codex-plugin:codex', 'dsh-bundle:dsh']);
    assert.equal((await run(['uninstall']))[0], 0);
    assert.deepEqual(await snapshotTree(home), before);
  } finally { await cleanup(); }
});

test('install --harness with a failing precondition exits 5 with the manual guide and changes nothing', async () => {
  const { run, profile, env, cleanup } = await fixture();
  try {
    assert.equal((await run(['install']))[0], 0);
    assert.equal((await run(['uninstall', '--harness', 'dsh']))[0], 0);
    await writeFile(join(profile, 'cordis.patch.yml'), `[ { id: ms-dsh-client, disabled: true } ]\n`);
    const manifest = await readFile(env.paths.manifest, 'utf8');
    const [code, out, err] = await run(['install', '--harness', 'dsh']);
    assert.equal(code, 5);
    assert.equal(out, '');
    assert.match(err, /^ms: INSTALL_PRECONDITION_FAILED: .*ms-dsh-client.*; manual install: docs\/user-guide\.md#manual-dsh/);
    assert.equal(await readFile(env.paths.manifest, 'utf8'), manifest);
  } finally { await cleanup(); }
});

test('install --harness that fails while writing rolls back only that harness', async () => {
  let failing = false;
  const generate: PluginGenerator = async options => { if (failing) throw new Error('boom'); await generator(options); };
  const { home, run, harnessesOf, cleanup } = await fixture({ generate });
  try {
    assert.equal((await run(['install']))[0], 0);
    assert.equal((await run(['uninstall', '--harness', 'claude-code']))[0], 0);
    const between = await snapshotTree(home);
    const records = await harnessesOf();
    failing = true;
    const [code, , err] = await run(['install', '--harness', 'claude-code']);
    assert.equal(code, 5);
    assert.match(err, /^ms: INSTALL_FAILED/);
    assert.deepEqual(await harnessesOf(), records);
    assert.deepEqual(await snapshotTree(home), between);
  } finally { await cleanup(); }
});

test('uninstall --harness that meets a conflict keeps that harness record for a rerun and leaves the rest', async () => {
  const { env, run, profile, harnessesOf, cleanup } = await fixture();
  try {
    assert.equal((await run(['install']))[0], 0);
    await writeFile(join(profile, 'cordis.patch.yml'), `${DESKTOP_PATCH}- id: ms-dsh-client\n  name: x\n`);
    const [code, , err] = await run(['uninstall', '--harness', 'dsh']);
    assert.equal(code, 6);
    assert.match(err, /UNINSTALL_CONFLICT[\s\S]*rerun ms uninstall --harness dsh/);
    assert.equal((await loadManifest(env.paths)).state, 'installed');
    assert.ok((await harnessesOf()).includes('dsh-bundle:dsh'));
    await writeFile(join(profile, 'cordis.patch.yml'), DESKTOP_PATCH);
    assert.equal((await run(['uninstall', '--harness', 'dsh']))[0], 0);
    assert.ok(!(await harnessesOf()).includes('dsh-bundle:dsh'));
    assert.equal(JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')).dependencies[DSH_PACKAGE], undefined);
  } finally { await cleanup(); }
});

