// INPUT: An installed temp HOME, changing fake pins, a fake plugin generator and a recording reload call.
// OUTPUT: repin diff/dry-run, config.json key preservation, plugin regeneration, conflict and daemon-offline regressions.
// POS: Offline repin tests; never hashes real binaries, touches ~/.claude or talks to a real msd.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { planClaudeMarketplaceStep, type PluginGenerator } from '../../src/cli/claude-marketplace-step.ts';
import { CliError } from '../../src/cli/errors.ts';
import { applyInstall } from '../../src/cli/install-apply.ts';
import { planInstall } from '../../src/cli/install.ts';
import type { PinSet } from '../../src/cli/pins.ts';
import { applyRepin, describeRepin, planRepin, type RepinDeps } from '../../src/cli/repin.ts';
import { applyUninstall, loadManifest } from '../../src/cli/uninstall.ts';
import { FAKE_PINS, makeEnv, makeHome, makeSource, recordingLaunchctl, snapshotTree } from './install-fixture.ts';

const generator: PluginGenerator = async ({ directory, pythonPath }) => {
  await mkdir(join(directory, '.claude-plugin'), { recursive: true, mode: 0o700 });
  await writeFile(join(directory, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'ms-local' }), { mode: 0o600 });
  await mkdir(join(directory, 'hooks'), { recursive: true, mode: 0o700 });
  await writeFile(join(directory, 'hooks', 'hooks.json'), JSON.stringify({ pythonPath }), { mode: 0o600 });
};

const NEW_PYTHON = { path: '/opt/python-3.13.15/Python.app/Contents/MacOS/Python', sha256: 'c'.repeat(64) };
const NEW_WRAPPERS = { wrapperPins: [{ path: '/bin/zsh', sha256: 'e'.repeat(64) }] };

async function installed() {
  const home = await makeHome();
  const source = await makeSource();
  const base = makeEnv(home, source);
  const env = { ...base, planClaude: (options: { pythonPath: string }) =>
    planClaudeMarketplaceStep({ paths: base.paths, generate: generator, claude: base.claudeCli }, options) };
  const before = await snapshotTree(home);
  await applyInstall(await planInstall(env), env);
  let pins: PinSet = FAKE_PINS;
  const reloads: string[] = [];
  const deps: RepinDeps = {
    paths: env.paths, now: () => '2026-10-20T09:00:00.000Z', discoverPins: async () => pins, generate: generator,
    reload: async () => { reloads.push('reload'); return { restartRequired: pins.python.path !== FAKE_PINS.python.path }; },
    restart: async () => { reloads.push('restart'); return true; },
  };
  const config = () => readFile(join(env.paths.root, 'config.json'), 'utf8').then(text => JSON.parse(text));
  const plugin = join(env.paths.root, 'claude-marketplace', 'hooks', 'hooks.json');
  return {
    home, env, deps, reloads, before, config, plugin, setPins: (next: PinSet) => { pins = next; },
    cleanup: async () => { await rm(home, { recursive: true, force: true }); await rm(source.root, { recursive: true, force: true }); },
  };
}

test('a config.json that is not schemaVersion 4 is refused before any discovery or write', async () => {
  const run = await installed();
  try {
    const path = join(run.env.paths.root, 'config.json');
    for (const schemaVersion of [1, 2, 3, '4', undefined]) {
      await writeFile(path, JSON.stringify({ ...(await run.config()), schemaVersion }));
      let discovered = 0;
      const deps = { ...run.deps, discoverPins: async () => { discovered++; return FAKE_PINS; } };
      await assert.rejects(planRepin(deps), { code: 'MANIFEST_INVALID', detail: 'config.json is not schemaVersion 4; run ms uninstall, then ms install' });
      assert.equal(discovered, 0);
    }
    assert.deepEqual(run.reloads, []);
  } finally { await run.cleanup(); }
});

test('unchanged pins write nothing and do not reload', async () => {
  const run = await installed();
  try {
    const snapshot = await snapshotTree(run.home);
    const plan = await planRepin(run.deps);
    assert.equal(describeRepin(plan), 'ms repin: pins unchanged (nothing written)');
    assert.equal(await applyRepin(plan, run.deps), 'ms repin: pins unchanged (nothing written)');
    assert.deepEqual(await snapshotTree(run.home), snapshot);
    assert.deepEqual(run.reloads, []);
  } finally { await run.cleanup(); }
});

test('a wrapper pin change rewrites only the pin keys, keeps runtime config changes and reloads msd', async () => {
  const run = await installed();
  try {
    const edited = { ...(await run.config()), autoRegister: { claude: true, dsh: false, codex: false } };
    await writeFile(join(run.env.paths.root, 'config.json'), JSON.stringify(edited));
    run.setPins({ ...FAKE_PINS, claude: NEW_WRAPPERS });
    const plan = await planRepin(run.deps);
    const dry = describeRepin(plan);
    assert.match(dry, /^ms repin plan \(dry run, nothing written\):/);
    assert.match(dry, /wrapperPins: \(none\) → \/bin\/zsh \(eeeeeeeeeeee\)/);
    assert.doesNotMatch(dry, /cliPins|appPin|appHelperPins/);
    assert.doesNotMatch(dry, /regenerate/);
    const pluginBefore = await readFile(run.plugin, 'utf8');
    const out = await applyRepin(plan, run.deps);
    assert.match(out, /^ms repin: pins updated\n/);
    assert.match(out, /msd reloaded config\.json$/);
    assert.deepEqual(await run.config(), { ...edited, claude: NEW_WRAPPERS });
    assert.equal(await readFile(run.plugin, 'utf8'), pluginBefore);
    assert.deepEqual(run.reloads, ['reload']);
  } finally { await run.cleanup(); }
});

test('a moved Python regenerates the plugin, updates the manifest hashes and uninstall stays exact', async () => {
  const run = await installed();
  try {
    run.setPins({ ...FAKE_PINS, python: NEW_PYTHON });
    const plan = await planRepin(run.deps);
    assert.match(describeRepin(plan), /regenerate .*claude-marketplace with the new Python path/);
    const out = await applyRepin(plan, run.deps);
    assert.match(out, /open Claude sessions need \/reload-plugins/);
    assert.match(out, /msd restarted \(Python pin changed\)$/);
    assert.deepEqual(run.reloads, ['reload', 'restart']);
    assert.deepEqual(JSON.parse(await readFile(run.plugin, 'utf8')), { pythonPath: NEW_PYTHON.path });
    assert.deepEqual((await run.config()).python, NEW_PYTHON);
    await applyUninstall(await loadManifest(run.env.paths), { paths: run.env.paths, launchctl: recordingLaunchctl().launchctl, uid: 501, dshPnpm: run.env.dshPnpm, claudeCli: run.env.claudeCli, codexCli: run.env.codexCli }, false);
    assert.deepEqual(await snapshotTree(run.home), run.before);
  } finally { await run.cleanup(); }
});

test('a user-edited plugin blocks a Python repin before any write; a failing generator restores the old plugin', async () => {
  const run = await installed();
  try {
    run.setPins({ ...FAKE_PINS, python: NEW_PYTHON });
    await writeFile(run.plugin, 'mine');
    const configBefore = await run.config();
    await assert.rejects(applyRepin(await planRepin(run.deps), run.deps), { code: 'REPIN_CONFLICT' });
    assert.equal(await readFile(run.plugin, 'utf8'), 'mine');
    assert.deepEqual(await run.config(), configBefore);
    await writeFile(run.plugin, JSON.stringify({ pythonPath: FAKE_PINS.python.path }), { mode: 0o600 });
    const failing = { ...run.deps, generate: async () => { throw new Error('CLAUDE_PLUGIN_PREPARATION_FAILED'); } };
    await assert.rejects(applyRepin(await planRepin(failing), failing), { code: 'REPIN_FAILED' });
    assert.deepEqual(JSON.parse(await readFile(run.plugin, 'utf8')), { pythonPath: FAKE_PINS.python.path });
    assert.deepEqual(await run.config(), configBefore);
  } finally { await run.cleanup(); }
});

test('offline msd still gets the new pins on next start; other reload errors surface; not installed is refused', async () => {
  const run = await installed();
  try {
    run.setPins({ ...FAKE_PINS, claude: NEW_WRAPPERS });
    const offline = { ...run.deps, reload: async () => { throw new CliError('DAEMON_UNAVAILABLE'); } };
    assert.match(await applyRepin(await planRepin(offline), offline), /msd not running; new pins apply at next start$/);
    run.setPins(FAKE_PINS);
    const refusing = { ...run.deps, reload: async () => { throw new CliError('DAEMON_ERROR', 'UNKNOWN_METHOD'); } };
    await assert.rejects(applyRepin(await planRepin(refusing), refusing), { code: 'DAEMON_ERROR', detail: 'UNKNOWN_METHOD' });
    run.setPins({ ...FAKE_PINS, claude: NEW_WRAPPERS });
    const garbled = { ...run.deps, reload: async () => ({ ok: true }) };
    await assert.rejects(applyRepin(await planRepin(garbled), garbled), { code: 'DAEMON_PROTOCOL_INVALID' });
    run.setPins({ ...FAKE_PINS, python: NEW_PYTHON });
    const unloaded = { ...run.deps, restart: async () => false };
    assert.match(await applyRepin(await planRepin(unloaded), unloaded), /msd not loaded; new pins apply at next start$/);
    await rm(run.env.paths.root, { recursive: true, force: true });
    await assert.rejects(planRepin(run.deps), { code: 'NOT_INSTALLED' });
  } finally { await run.cleanup(); }
});
