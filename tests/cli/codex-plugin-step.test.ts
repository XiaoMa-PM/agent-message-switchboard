// INPUT: Temp HOME with a synthetic ~/.codex, the real marketplace generator and fakeCodexCli for `codex plugin`.
// OUTPUT: Codex plugin step regressions: argv, approval subtables, ledger and backup, exact restore when untouched, owned-table
//         removal after trust or later edits, an interrupted install (no afterSha: CLI removal keeping edits, or a no-op), cache
//         cleanup, CLI and generator failures, preconditions, the real runner's lookup.
// POS: Offline tests for the Codex step; never runs the real codex CLI or touches the real ~/.codex.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CODEX_PLUGIN_ID, CODEX_TRUST_KEYS } from '../../src/adapters/codex/plugin.ts';
import { planCodexPluginStep, systemCodexCli } from '../../src/cli/codex-plugin-step.ts';
import type { CliError } from '../../src/cli/errors.ts';
import { applyInstall } from '../../src/cli/install-apply.ts';
import { describePlan, planInstall } from '../../src/cli/install.ts';
import { restoreExact } from '../../src/cli/revert-file.ts';
import { applyUninstall, loadManifest } from '../../src/cli/uninstall.ts';
import { fakeCodexCli, interruptLedger, makeEnv, makeHome, makeSource, recordingLaunchctl, snapshotTree, STUB_CLAUDE } from './install-fixture.ts';
import { PRODUCT_VERSION } from '../../src/protocol/product-version.ts';

const CONFIG = '# Synthetic config\n# Preserve comments and terminal byte\n[projects."/tmp/x"]\ntrust_level = "trusted"';
const TRUST = `\n[hooks.state]\n${CODEX_TRUST_KEYS.map((key, index) => `\n[hooks.state.${JSON.stringify(key)}]\ntrusted_hash = "sha256:${'abcdef'[index].repeat(64)}"\n`).join('')}`;

async function fixture(options: { adapter?: boolean } = {}) {
  const home = await makeHome();
  const source = await makeSource();
  if (options.adapter !== false) {
    await mkdir(join(source.root, 'src/adapters/codex'), { recursive: true });
    await writeFile(join(source.root, 'src/adapters/codex/mcp-main.ts'), '// adapter\n');
  }
  await mkdir(join(home, '.codex', '.tmp', 'marketplaces'), { recursive: true });
  await mkdir(join(home, '.codex', 'tmp', 'arg0-macos'), { recursive: true });
  await writeFile(join(home, '.codex', 'config.toml'), CONFIG, { mode: 0o600 });
  const fake = fakeCodexCli(home);
  const env = makeEnv(home, source, STUB_CLAUDE, undefined, undefined, fake.cli);
  const deps = () => ({ paths: env.paths, launchctl: recordingLaunchctl().launchctl, uid: 501, dshPnpm: env.dshPnpm, claudeCli: env.claudeCli, codexCli: fake.cli });
  const uninstall = async () => applyUninstall(await loadManifest(env.paths), deps(), false);
  const config = join(home, '.codex', 'config.toml');
  const marketplace = join(env.paths.root, 'codex-marketplace');
  const cleanup = async () => { await rm(home, { recursive: true, force: true }); await rm(source.root, { recursive: true, force: true }); };
  return { home, env, fake, uninstall, config, marketplace, cleanup };
}

test('install generates the marketplace, runs codex plugin marketplace add and add, appends the two approval subtables and journals config.toml', async () => {
  const { env, fake, config, marketplace, cleanup } = await fixture();
  try {
    const plan = await planInstall(env);
    const text = describePlan(plan, env.paths);
    for (const fragment of [`generate local marketplace ${marketplace}`, `codex plugin marketplace add ${marketplace}`,
      'MCP server ms, SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, Stop and Interrupt hooks, skills',
      `codex plugin add ${CODEX_PLUGIN_ID}`, `[plugins."${CODEX_PLUGIN_ID}".mcp_servers.ms.tools.router_send]`]) assert.ok(text.includes(fragment), fragment);
    assert.deepEqual(fake.calls, []);
    assert.match(await applyInstall(plan, env), /\ncodex: installed \(start a new Codex session and trust all six ms hooks in \/hooks; until UserPromptSubmit, PreToolUse and PermissionRequest are trusted, act letters are handled as direct, and an untrusted Stop or Interrupt only means no no-reply receipts\)/);
    assert.deepEqual(fake.calls, [['plugin', 'marketplace', 'add', marketplace], ['plugin', 'add', CODEX_PLUGIN_ID]]);
    assert.equal(await readFile(config, 'utf8'), `${CONFIG}\n\n[marketplaces.ms-local]\nsource_type = "local"\nsource = ${JSON.stringify(marketplace)}\n`
      + `\n[plugins."${CODEX_PLUGIN_ID}"]\nenabled = true\n`
      + `\n[plugins."${CODEX_PLUGIN_ID}".mcp_servers.ms.tools.router_send]\napproval_mode = "approve"\n`
      + `\n[plugins."${CODEX_PLUGIN_ID}".mcp_servers.ms.tools.router_reply]\napproval_mode = "approve"\n`);
    const version = JSON.parse(await readFile(join(marketplace, 'plugins', 'ms', '.codex-plugin', 'plugin.json'), 'utf8')).version;
    assert.equal(version, `${PRODUCT_VERSION}-${plan.bundleDir.split('/').at(-1)}`);
    const records = (await loadManifest(env.paths)).records.filter(record => record.harness === 'codex');
    assert.deepEqual(records.map(record => record.kind), ['tree', 'codex-plugin']);
    const record = records[1];
    assert.ok(record.kind === 'codex-plugin');
    assert.equal(await readFile(record.config.backup!, 'utf8'), CONFIG);
    assert.equal(record.hooksState, false);
    assert.ok(record.absent.includes(join(env.paths.home, '.codex', 'plugins', 'cache', 'ms-local')));
  } finally { await cleanup(); }
});

test('uninstall of an untouched config.toml runs the official removes, then restores it and HOME byte for byte', async () => {
  const { home, env, fake, uninstall, cleanup } = await fixture();
  try {
    const before = await snapshotTree(home);
    await applyInstall(await planInstall(env), env);
    assert.match(await uninstall(), /restored exactly/);
    assert.deepEqual(fake.calls.slice(2), [['plugin', 'remove', CODEX_PLUGIN_ID], ['plugin', 'marketplace', 'remove', 'ms-local']]);
    assert.deepEqual(await snapshotTree(home), before);
  } finally { await cleanup(); }
});

test('after the user trusted the hooks, uninstall drops the ms tables, the ms trust tables and the new empty [hooks.state]', async () => {
  for (const label of ['trust only', 'trust and a later edit', 'trust next to an older [hooks.state]']) {
    const { home, env, uninstall, config, cleanup } = await fixture();
    try {
      const older = '\n[hooks.state]\n\n[hooks.state."other@m:hooks/hooks.json:session_start:0:0"]\ntrusted_hash = "sha256:cc"\n';
      if (label === 'trust next to an older [hooks.state]') await writeFile(config, CONFIG + older);
      const original = await readFile(config, 'utf8');
      const before = await snapshotTree(home);
      await applyInstall(await planInstall(env), env);
      const installed = await readFile(config, 'utf8');
      const later = label === 'trust and a later edit' ? '\n[projects."/tmp/y"]\ntrust_level = "trusted"\n' : '';
      const trust = label === 'trust next to an older [hooks.state]' ? TRUST.replace('\n[hooks.state]\n', '') : TRUST;
      await writeFile(config, installed + trust + later);
      assert.match(await uninstall(), label === 'trust and a later edit' ? /later changes kept/ : /restored exactly/, label);
      if (label === 'trust and a later edit') {
        assert.equal(await readFile(config, 'utf8'), `${CONFIG}\n${later}`, label);
        await assert.rejects(stat(env.paths.root), { code: 'ENOENT' });
      } else {
        assert.equal(await readFile(config, 'utf8'), original, label);
        assert.deepEqual(await snapshotTree(home), before, label);
      }
    } finally { await cleanup(); }
  }
});

test('a plugin the user already removed with codex counts as reverted: no codex call, exact bytes back, cache cleaned', async () => {
  const { home, env, fake, uninstall, cleanup } = await fixture();
  try {
    const before = await snapshotTree(home);
    await applyInstall(await planInstall(env), env);
    await fake.cli.run(['plugin', 'remove', CODEX_PLUGIN_ID]);
    await fake.cli.run(['plugin', 'marketplace', 'remove', 'ms-local']);
    const calls = fake.calls.length;
    await uninstall();
    assert.equal(fake.calls.length, calls);
    assert.deepEqual(await snapshotTree(home), before);
  } finally { await cleanup(); }
});

test('without a codex executable, an untouched config.toml is restored from the backup; a trusted one is a kept conflict', async () => {
  for (const trusted of [false, true]) {
    const { home, env, fake, uninstall, config, cleanup } = await fixture();
    try {
      const before = await snapshotTree(home);
      await applyInstall(await planInstall(env), env);
      if (trusted) await writeFile(config, (await readFile(config, 'utf8')) + TRUST);
      fake.ready.value = false;
      if (!trusted) {
        assert.match(await uninstall(), /codex CLI not found/);
        assert.deepEqual(await snapshotTree(home), before);
      } else {
        await assert.rejects(uninstall(), (error: CliError) => error.code === 'UNINSTALL_CONFLICT' && /codex plugin remove/.test(error.detail ?? ''));
      }
    } finally { await cleanup(); }
  }
});

test('a failing codex command during install rolls HOME back; during uninstall it is a kept conflict that a rerun finishes', async () => {
  for (const verb of ['marketplace add', 'add']) {
    const { home, env, fake, cleanup } = await fixture();
    try {
      fake.fail.add(verb);
      const before = await snapshotTree(home);
      await assert.rejects(applyInstall(await planInstall(env), env), (error: CliError) =>
        error.code === 'INSTALL_FAILED' && (error.detail ?? '').includes(`CODEX_CLI_FAILED: ${verb} exit 1`));
      assert.deepEqual(await snapshotTree(home), before, verb);
    } finally { await cleanup(); }
  }
  const { env, fake, uninstall, config, cleanup } = await fixture();
  try {
    await applyInstall(await planInstall(env), env);
    fake.fail.add('remove');
    await assert.rejects(uninstall(), (error: CliError) => error.code === 'UNINSTALL_CONFLICT' && /remove exit 1/.test(error.detail ?? ''));
    assert.ok((await loadManifest(env.paths)).records.some(record => record.kind === 'codex-plugin'));
    fake.fail.clear();
    await uninstall();
    assert.doesNotMatch(await readFile(config, 'utf8'), /ms-local/);
  } finally { await cleanup(); }
});

// An install killed before it recorded what the codex CLI wrote leaves no afterSha; the backup never overwrites.
test('after an interrupted install a changed config.toml loses only ms tables through the CLI; an unchanged one is a no-op', async () => {
  for (const label of ['changed', 'unchanged']) {
    const { home, env, fake, uninstall, config, cleanup } = await fixture();
    try {
      const before = await snapshotTree(home);
      await applyInstall(await planInstall(env), env);
      if (label === 'changed') await writeFile(config, (await readFile(config, 'utf8')).replace(/^/, 'model_reasoning_effort = "high"\n'));
      const record = await interruptLedger(env.paths.manifest, 'codex-plugin');
      if (label === 'unchanged' && record.kind === 'codex-plugin') await restoreExact(record.config);
      const calls = fake.calls.length;
      const out = await uninstall();
      if (label === 'unchanged') {
        assert.match(out, /config\.toml: unchanged by install/);
        assert.equal(fake.calls.length, calls);
        assert.deepEqual(await snapshotTree(home), before);
        continue;
      }
      assert.match(out, new RegExp(`${CODEX_PLUGIN_ID}: removed with the codex CLI, later changes kept`));
      const text = await readFile(config, 'utf8');
      assert.ok(text.startsWith('model_reasoning_effort = "high"\n'), text);
      assert.doesNotMatch(text, /ms-local/);
    } finally { await cleanup(); }
  }
});

test('ms entries left in a form ms does not edit are a kept conflict', async () => {
  const { env, uninstall, config, cleanup } = await fixture();
  try {
    await applyInstall(await planInstall(env), env);
    await writeFile(config, `plugins."${CODEX_PLUGIN_ID}".note = "mine"\n${await readFile(config, 'utf8')}${TRUST}`);
    await assert.rejects(uninstall(), (error: CliError) => error.code === 'UNINSTALL_CONFLICT' && /ms-local/.test(error.detail ?? ''));
    assert.match(await readFile(config, 'utf8'), /^plugins\."ms@ms-local"\.note = "mine"\n/);
  } finally { await cleanup(); }
});

test('preconditions skip only Codex: no codex, no config.toml, ms-local known, an [mcp_servers.ms] table, or a build without the adapter', async () => {
  const cases: Record<string, (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>> = {
    'no codex executable': async f => { f.fake.ready.value = false; },
    'no config.toml': async f => { await rm(f.config); },
    'marketplace already known': async f => { await writeFile(f.config, `${CONFIG}\n\n[marketplaces.ms-local]\nsource_type = "local"\n`); },
    'plugin already known': async f => { await writeFile(f.config, `${CONFIG}\n\n[plugins."${CODEX_PLUGIN_ID}"]\nenabled = true\n`); },
    'an [mcp_servers.ms] table': async f => { await writeFile(f.config, `${CONFIG}\n\n[mcp_servers.ms]\ncommand = "node"\n`); },
  };
  for (const [label, prepare] of Object.entries(cases)) {
    const f = await fixture();
    try {
      await prepare(f);
      assert.match(describePlan(await planInstall(f.env), f.env.paths), /\n {2}codex: skipped \(.+\); manual install: docs\/user-guide\.md#manual-codex/, label);
      await applyInstall(await planInstall(f.env), f.env);
      assert.deepEqual(f.fake.calls, [], label);
      assert.ok(!(await loadManifest(f.env.paths)).records.some(record => record.harness === 'codex'), label);
    } finally { await f.cleanup(); }
  }
  const bare = await fixture({ adapter: false });
  try {
    assert.match(describePlan(await planInstall(bare.env), bare.env.paths), /codex: skipped \(this build has no src\/adapters\/codex\/mcp-main\.ts\)/);
  } finally { await bare.cleanup(); }
});

test('a generator failure rolls everything back before any codex command', async () => {
  const { home, env, fake, cleanup } = await fixture();
  try {
    const failing = { ...env, planCodex: (options: { bundleDir: string; bundled: (relative: string) => boolean }) =>
      planCodexPluginStep({ paths: env.paths, generate: async () => { throw new Error('CODEX_MARKETPLACE_PREPARATION_FAILED'); }, codex: fake.cli }, options) };
    const before = await snapshotTree(home);
    await assert.rejects(applyInstall(await planInstall(failing), failing), { code: 'INSTALL_FAILED' });
    assert.deepEqual(await snapshotTree(home), before);
    assert.deepEqual(fake.calls, []);
  } finally { await cleanup(); }
});

test('the real runner uses codex on PATH first, then the ChatGPT.app copy, passes argv through and reports a non-zero exit', async () => {
  const dir = await realpath(await mkdtemp('/tmp/ms-codex-bin-'));
  try {
    const record = join(dir, 'record.txt');
    const script = (name: string) => `#!/bin/sh\necho "${name}" > '${record}'\nfor a in "$@"; do echo "arg:$a"; done >> '${record}'\n[ "$2" = "remove" ] && exit 3\nexit 0\n`;
    await mkdir(join(dir, 'bin'));
    await writeFile(join(dir, 'app-codex'), script('app'));
    await chmod(join(dir, 'app-codex'), 0o755);
    const missing = systemCodexCli('', join(dir, 'absent'));
    assert.equal(await missing.ready(), false);
    await assert.rejects(missing.run(['plugin', 'list']), { code: 'CODEX_CLI_FAILED', detail: 'codex not found' });
    const app = systemCodexCli(`relative:${join(dir, 'bin')}`, join(dir, 'app-codex'));
    assert.equal(await app.path(), join(dir, 'app-codex'));
    await app.run(['plugin', 'add', CODEX_PLUGIN_ID]);
    assert.equal(await readFile(record, 'utf8'), `app\narg:plugin\narg:add\narg:${CODEX_PLUGIN_ID}\n`);
    await writeFile(join(dir, 'bin', 'codex'), script('path'));
    await chmod(join(dir, 'bin', 'codex'), 0o755);
    assert.equal(await app.path(), join(dir, 'bin', 'codex'));
    await assert.rejects(app.run(['plugin', 'remove', CODEX_PLUGIN_ID]), { code: 'CODEX_CLI_FAILED', detail: 'remove exit 3' });
    assert.equal((await readFile(record, 'utf8')).split('\n')[0], 'path');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
