// INPUT: Temp HOME with ~/.claude/settings.json, a fake marketplace generator and fakeClaudeCli standing in for `claude plugin`.
// OUTPUT: Claude marketplace-plugin regressions: command argv, ledger and backups, exact restore when untouched, owned-key
//         removal after later changes, an interrupted install (no afterSha: CLI removal keeping changes, or a no-op), cache cleanup,
//         CLI/generator failures rolled back, preconditions that skip Claude.
// POS: Offline tests for the Claude step; never runs the real claude CLI or touches the real ~/.claude.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CLAUDE_MARKETPLACE, CLAUDE_PLUGIN_ID, planClaudeMarketplaceStep, systemClaudeCli, type PluginGenerator } from '../../src/cli/claude-marketplace-step.ts';
import type { CliError } from '../../src/cli/errors.ts';
import { sha256 } from '../../src/cli/fs-ops.ts';
import { restoreExact } from '../../src/cli/revert-file.ts';
import { applyInstall } from '../../src/cli/install-apply.ts';
import { describePlan, planInstall } from '../../src/cli/install.ts';
import { applyUninstall, loadManifest } from '../../src/cli/uninstall.ts';
import { FAKE_PINS, fakeClaudeCli, interruptLedger, makeEnv, makeHome, makeSource, recordingLaunchctl, snapshotTree } from './install-fixture.ts';

const generator: PluginGenerator = async ({ directory, root, pythonPath }) => {
  await mkdir(join(directory, '.claude-plugin'), { recursive: true, mode: 0o700 });
  await mkdir(join(directory, 'plugins', 'ms', 'hooks'), { recursive: true, mode: 0o700 });
  await writeFile(join(directory, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'ms-local' }), { mode: 0o600 });
  await writeFile(join(directory, 'plugins', 'ms', 'hooks', 'hooks.json'), JSON.stringify({ root, pythonPath }), { mode: 0o600 });
};

async function fixture(generate: PluginGenerator = generator) {
  const home = await makeHome();
  const source = await makeSource();
  const fake = fakeClaudeCli(home);
  const base = makeEnv(home, source, undefined, undefined, fake.cli);
  const env = { ...base, planClaude: (o: { pythonPath: string }) => planClaudeMarketplaceStep({ paths: base.paths, generate, claude: fake.cli }, o) };
  const deps = () => ({ paths: env.paths, launchctl: recordingLaunchctl().launchctl, uid: 501, dshPnpm: env.dshPnpm, claudeCli: fake.cli, codexCli: env.codexCli });
  const uninstall = async () => applyUninstall(await loadManifest(env.paths), deps(), false);
  const marketplace = join(env.paths.root, 'claude-marketplace');
  const settings = join(home, '.claude', 'settings.json');
  const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
  const cleanup = async () => { await rm(home, { recursive: true, force: true }); await rm(source.root, { recursive: true, force: true }); };
  return { home, env, fake, deps, uninstall, marketplace, settings, json, cleanup };
}

test('install generates the ms-local marketplace, adds and installs it with the claude CLI and journals the three registry files', async () => {
  const { home, env, fake, marketplace, settings, json, cleanup } = await fixture();
  try {
    const original = await readFile(settings, 'utf8');
    const plan = await planInstall(env);
    const text = describePlan(plan, env.paths);
    for (const fragment of [`generate local marketplace ${marketplace}`, `claude plugin marketplace add ${marketplace}`,
      `claude plugin install ${CLAUDE_PLUGIN_ID} -s user`, '~/.claude/settings.json']) assert.ok(text.includes(fragment), fragment);
    assert.deepEqual(fake.calls, []);
    await applyInstall(plan, env);
    assert.deepEqual(fake.calls, [['plugin', 'marketplace', 'add', marketplace], ['plugin', 'install', CLAUDE_PLUGIN_ID, '-s', 'user']]);
    assert.deepEqual(await json(join(marketplace, 'plugins', 'ms', 'hooks', 'hooks.json')), { root: env.paths.root, pythonPath: FAKE_PINS.python.path });
    assert.equal((await json(settings)).enabledPlugins[CLAUDE_PLUGIN_ID], true);
    const records = (await loadManifest(env.paths)).records.filter(record => record.harness === 'claude-code');
    assert.deepEqual(records.map(record => record.kind), ['tree', 'claude-plugin']);
    const record = records[1];
    assert.ok(record.kind === 'claude-plugin');
    assert.deepEqual([record.marketplace, record.pluginId], [CLAUDE_MARKETPLACE, CLAUDE_PLUGIN_ID]);
    assert.equal(await readFile(record.settings.backup!, 'utf8'), original);
    assert.equal(record.settings.afterSha, sha256(await readFile(settings)));
    assert.deepEqual([record.knownMarketplaces.created, record.installedPlugins.created], [true, true]);
    assert.ok(record.absent.includes(join(home, '.claude', 'plugins', 'cache', CLAUDE_MARKETPLACE)));
  } finally { await cleanup(); }
});

test('uninstall of untouched Claude files runs the official commands, then restores the three files and HOME byte for byte', async () => {
  const { home, env, fake, uninstall, cleanup } = await fixture();
  try {
    const before = await snapshotTree(home);
    await applyInstall(await planInstall(env), env);
    const out = await uninstall();
    assert.match(out, /restored exactly/);
    assert.deepEqual(fake.calls.slice(2), [['plugin', 'uninstall', CLAUDE_PLUGIN_ID, '-s', 'user'], ['plugin', 'marketplace', 'remove', CLAUDE_MARKETPLACE]]);
    assert.deepEqual(await snapshotTree(home), before);
  } finally { await cleanup(); }
});

test('after a later Claude change, uninstall only removes the ms keys, keeps the rest and cleans the cache copy', async () => {
  const { home, env, fake, uninstall, settings, json, cleanup } = await fixture();
  try {
    await applyInstall(await planInstall(env), env);
    const changed = { ...(await json(settings)), theme: 'dark' };
    await writeFile(settings, JSON.stringify(changed));
    const out = await uninstall();
    assert.match(out, /removed with the claude CLI, later changes kept/);
    assert.equal(fake.calls.length, 4);
    const after = await json(settings);
    assert.equal(after.theme, 'dark');
    assert.equal(after.enabledPlugins['other@m'], true);
    assert.equal(after.enabledPlugins[CLAUDE_PLUGIN_ID], undefined);
    assert.equal(after.extraKnownMarketplaces[CLAUDE_MARKETPLACE], undefined);
    await assert.rejects(stat(join(home, '.claude', 'plugins', 'cache', CLAUDE_MARKETPLACE)), { code: 'ENOENT' });
    await assert.rejects(stat(env.paths.root), { code: 'ENOENT' });
  } finally { await cleanup(); }
});

test('a plugin the user already removed in /plugin counts as reverted; only the cache copy is cleaned', async () => {
  const { home, env, fake, uninstall, cleanup } = await fixture();
  try {
    await applyInstall(await planInstall(env), env);
    await fake.cli.run(['plugin', 'uninstall', CLAUDE_PLUGIN_ID, '-s', 'user']);
    await fake.cli.run(['plugin', 'marketplace', 'remove', CLAUDE_MARKETPLACE]);
    const calls = fake.calls.length;
    assert.match(await uninstall(), /already removed from Claude/);
    assert.equal(fake.calls.length, calls);
    await assert.rejects(stat(join(home, '.claude', 'plugins', 'cache', CLAUDE_MARKETPLACE)), { code: 'ENOENT' });
  } finally { await cleanup(); }
});

test('a failing claude command during install rolls HOME back byte for byte', async () => {
  for (const verb of ['marketplace add', 'install']) {
    const { home, env, fake, cleanup } = await fixture();
    try {
      fake.fail.add(verb);
      const before = await snapshotTree(home);
      await assert.rejects(applyInstall(await planInstall(env), env), (error: CliError) =>
        error.code === 'INSTALL_FAILED' && (error.detail ?? '').includes(`CLAUDE_CLI_FAILED: ${verb} exit 1`));
      assert.deepEqual(await snapshotTree(home), before, verb);
    } finally { await cleanup(); }
  }
});

// An install killed before it recorded what the claude CLI wrote leaves no afterSha; the backups never overwrite.
test('after an interrupted install changed Claude files lose only the ms keys through the CLI; unchanged ones are a no-op', async () => {
  for (const label of ['changed', 'unchanged']) {
    const { home, env, fake, uninstall, settings, json, cleanup } = await fixture();
    try {
      const before = await snapshotTree(home);
      await applyInstall(await planInstall(env), env);
      if (label === 'changed') await writeFile(settings, JSON.stringify({ ...(await json(settings)), theme: 'light' }, null, 2));
      const record = await interruptLedger(env.paths.manifest, 'claude-plugin');
      if (label === 'unchanged' && record.kind === 'claude-plugin') {
        for (const snap of [record.settings, record.knownMarketplaces, record.installedPlugins]) await restoreExact(snap);
      }
      const calls = fake.calls.length;
      const out = await uninstall();
      if (label === 'unchanged') {
        assert.match(out, /Claude files unchanged by install/);
        assert.equal(fake.calls.length, calls);
        assert.deepEqual(await snapshotTree(home), before);
        continue;
      }
      assert.match(out, new RegExp(`${CLAUDE_PLUGIN_ID}: removed with the claude CLI, later changes kept`));
      assert.deepEqual(fake.calls.slice(calls).map(call => call[1]), ['uninstall', 'marketplace']);
      const after = await json(settings);
      assert.equal(after.theme, 'light');
      assert.equal(after.enabledPlugins[CLAUDE_PLUGIN_ID], undefined);
    } finally { await cleanup(); }
  }
});

test('a failing claude command during uninstall is a kept conflict; a rerun finishes and the ms keys are gone', async () => {
  const { env, fake, uninstall, settings, json, cleanup } = await fixture();
  try {
    await applyInstall(await planInstall(env), env);
    fake.fail.add('marketplace remove');
    await assert.rejects(uninstall(), (error: CliError) => error.code === 'UNINSTALL_CONFLICT' && /marketplace remove exit 1/.test(error.detail ?? ''));
    assert.ok((await loadManifest(env.paths)).records.some(record => record.kind === 'claude-plugin'));
    fake.fail.clear();
    await uninstall();
    const after = await json(settings);
    assert.equal(after.enabledPlugins[CLAUDE_PLUGIN_ID], undefined);
    assert.equal(after.extraKnownMarketplaces[CLAUDE_MARKETPLACE], undefined);
  } finally { await cleanup(); }
});

test('without the claude CLI, untouched files are restored from the backups; changed ones are a kept conflict', async () => {
  for (const changed of [false, true]) {
    const { home, env, fake, uninstall, settings, cleanup } = await fixture();
    try {
      const before = await snapshotTree(home);
      await applyInstall(await planInstall(env), env);
      if (changed) await writeFile(settings, '{"mine":1}\n');
      fake.ready.value = false;
      if (!changed) {
        assert.match(await uninstall(), /claude CLI not found/);
        assert.deepEqual(await snapshotTree(home), before);
      } else {
        await assert.rejects(uninstall(), (error: CliError) => error.code === 'UNINSTALL_CONFLICT' && /\/plugin/.test(error.detail ?? ''));
      }
    } finally { await cleanup(); }
  }
});

test('preconditions skip only Claude: no claude CLI, or ms-local already known to Claude', async () => {
  const cases: Record<string, (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>> = {
    'no claude CLI': async f => { f.fake.ready.value = false; },
    'ms-local already known': async f => { await writeFile(f.settings, JSON.stringify({ extraKnownMarketplaces: { [CLAUDE_MARKETPLACE]: {} } })); },
    'ms@ms-local already enabled': async f => { await writeFile(f.settings, JSON.stringify({ enabledPlugins: { [CLAUDE_PLUGIN_ID]: true } })); },
    'settings.json not JSON': async f => { await writeFile(f.settings, '{ broken'); },
  };
  for (const [label, prepare] of Object.entries(cases)) {
    const f = await fixture();
    try {
      await prepare(f);
      assert.match(describePlan(await planInstall(f.env), f.env.paths), /\n {2}claude-code: skipped \(.+\); manual install: docs\/user-guide\.md#manual-claude-code/, label);
      await applyInstall(await planInstall(f.env), f.env);
      assert.deepEqual(f.fake.calls, [], label);
      assert.ok(!(await loadManifest(f.env.paths)).records.some(record => record.harness === 'claude-code'), label);
    } finally { await f.cleanup(); }
  }
});

test('a generator failure rolls everything back; a user edit inside the marketplace is a kept conflict', async () => {
  const failing = await fixture(async ({ directory }) => { await mkdir(directory); await writeFile(join(directory, 'partial'), 'x'); throw new Error('boom'); });
  try {
    const before = await snapshotTree(failing.home);
    await assert.rejects(applyInstall(await planInstall(failing.env), failing.env), { code: 'INSTALL_FAILED' });
    assert.deepEqual(await snapshotTree(failing.home), before);
    assert.deepEqual(failing.fake.calls, []);
  } finally { await failing.cleanup(); }
  const { env, marketplace, uninstall, cleanup } = await fixture();
  try {
    await applyInstall(await planInstall(env), env);
    await writeFile(join(marketplace, 'plugins', 'ms', 'hooks', 'hooks.json'), 'mine');
    await assert.rejects(uninstall(), (error: CliError) => error.code === 'UNINSTALL_CONFLICT' && (error.detail ?? '').includes(`${marketplace}: changed after install, kept`));
    assert.deepEqual((await loadManifest(env.paths)).records.map(record => record.kind), ['tree']);
  } finally { await cleanup(); }
});

test('the real runner finds claude on PATH, passes the argv through with stdin closed and reports a non-zero exit', async () => {
  const dir = await realpath(await mkdtemp('/tmp/ms-claude-bin-'));
  try {
    const record = join(dir, 'record.txt');
    await writeFile(join(dir, 'claude'), `#!/bin/sh\nfor a in "$@"; do echo "arg:$a"; done > '${record}'\n[ "$2" = "uninstall" ] && exit 4\nexit 0\n`);
    assert.equal(await systemClaudeCli(`relative:${dir}-absent`).ready(), false);
    await assert.rejects(systemClaudeCli('').run(['plugin', 'list']), { code: 'CLAUDE_CLI_FAILED', detail: 'claude not on PATH' });
    await chmod(join(dir, 'claude'), 0o755);
    const cli = systemClaudeCli(`relative:${dir}`);
    assert.equal(await cli.ready(), true);
    await cli.run(['plugin', 'marketplace', 'add', '/m d']);
    assert.equal(await readFile(record, 'utf8'), 'arg:plugin\narg:marketplace\narg:add\narg:/m d\n');
    await assert.rejects(cli.run(['plugin', 'uninstall', CLAUDE_PLUGIN_ID]), { code: 'CLAUDE_CLI_FAILED', detail: 'uninstall exit 4' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
