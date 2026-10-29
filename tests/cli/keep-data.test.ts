// INPUT: Temp HOME/source fixtures, a stub Claude step, a recording fake launchctl and hand-written kept config.json files.
// OUTPUT: uninstall --keep-data keeps state/ and config.json; the next install keeps matching settings; a failed one restores them.
// POS: Offline settings carry-over tests; never touches the real HOME, launchd, Claude or DSH.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describePlan, planInstall, type ClaudeStep, type InstallEnv } from '../../src/cli/install.ts';
import { applyInstall } from '../../src/cli/install-apply.ts';
import type { PinSet } from '../../src/cli/pins.ts';
import { applyUninstall, describeUninstall, loadManifest } from '../../src/cli/uninstall.ts';
import { FAKE_PINS, STUB_CLAUDE, makeEnv, makeHome, makeSource, recordingLaunchctl } from './install-fixture.ts';

const NEW_PINS: PinSet = Object.freeze({ python: { path: '/opt/homebrew/bin/python3.13', sha256: 'b'.repeat(64) }, claude: { wrapperPins: [] } });
const SETTINGS = {
  autoRegister: { claude: true, dsh: false, codex: true }, autoRegisterProjects: ['/Users/me/project'],
  replyMode: { claude: 'act', dsh: 'confirm', codex: 'direct' },
  actPreset: { claude: 'read-only', dsh: 'full-access', codex: 'workspace-write' }, linkBudget: { windowSeconds: 60, maxPushes: 5 },
};
const DEFAULTS = {
  autoRegister: { claude: false, dsh: false, codex: false }, autoRegisterProjects: [],
  replyMode: { claude: 'direct', dsh: 'direct', codex: 'direct' },
  actPreset: { claude: 'workspace-write', dsh: 'workspace-write', codex: 'workspace-write' }, linkBudget: { windowSeconds: 600, maxPushes: 30 },
};
const DEFAULT_LINES = [
  '  autoRegister: off for every harness', '  autoRegisterProjects: empty (every project)', '  replyMode: direct for every harness',
  '  actPreset: workspace-write for every harness', '  linkBudget: 30 pushes per 600 s',
];

async function fixture(claude: ClaudeStep = STUB_CLAUDE) {
  const home = await makeHome();
  const source = await makeSource();
  const env = makeEnv(home, source, claude);
  const config = join(env.paths.root, 'config.json');
  const uninstall = (keepData: boolean) => loadManifest(env.paths).then(manifest => applyUninstall(manifest,
    { paths: env.paths, launchctl: recordingLaunchctl().launchctl, uid: 501, dshPnpm: env.dshPnpm, claudeCli: env.claudeCli, codexCli: env.codexCli }, keepData));
  const keptRoot = async (text: string | null) => {
    await mkdir(join(env.paths.root, 'state'), { recursive: true, mode: 0o700 });
    await writeFile(join(env.paths.root, 'state', 'directory.json'), 'kept');
    if (text !== null) await writeFile(config, text, { mode: 0o600 });
  };
  const cleanup = async () => { await rm(home, { recursive: true, force: true }); await rm(source.root, { recursive: true, force: true }); };
  return { env, config, uninstall, keptRoot, cleanup };
}

const fileOf = (pins: PinSet, settings: object) => ({ schemaVersion: 4, python: pins.python, claude: pins.claude, ...settings });

test('uninstall --keep-data keeps state/ and config.json; the next install keeps every setting and re-detects the Python pin', async () => {
  const f = await fixture();
  try {
    await applyInstall(await planInstall(f.env), f.env);
    await mkdir(join(f.env.paths.root, 'state'), { mode: 0o700 });
    await writeFile(f.config, JSON.stringify(fileOf(FAKE_PINS, SETTINGS)), { mode: 0o600 });
    assert.match(describeUninstall(await loadManifest(f.env.paths), f.env.paths, true), /except state\/ and config\.json when no conflict remains/);
    assert.match(await f.uninstall(true), /\nremoved .+ except state\/ and config\.json\n/);
    assert.deepEqual((await readdir(f.env.paths.root)).sort(), ['config.json', 'state']);

    const env: InstallEnv = { ...f.env, discoverPins: async () => NEW_PINS };
    const plan = await planInstall(env);
    const kept = 'settings kept from the previous config.json: autoRegister, autoRegisterProjects, replyMode, actPreset, linkBudget (Python pin re-detected)';
    assert.ok(describePlan(plan, env.paths).split('\n').includes(`    ${kept}`));
    assert.ok((await applyInstall(plan, env)).split('\n').includes(kept));
    assert.deepEqual(JSON.parse(await readFile(f.config, 'utf8')), fileOf(NEW_PINS, SETTINGS));
    assert.equal((await stat(f.config)).mode & 0o777, 0o600);
  } finally { await f.cleanup(); }
});

test('a kept config.json with another schemaVersion, broken JSON, a failed check or none at all gives defaults, each named', async () => {
  const cases: Array<[string, string | null, string]> = [
    ['older schema', JSON.stringify({ ...fileOf(FAKE_PINS, SETTINGS), schemaVersion: 3 }), 'the kept config.json has schemaVersion 3, this version uses 4'],
    ['no schema', JSON.stringify({ python: FAKE_PINS.python }), 'the kept config.json has schemaVersion none, this version uses 4'],
    ['broken JSON', '{"schemaVersion":4,', 'the kept config.json is not valid JSON'],
    ['failed check', JSON.stringify(fileOf(FAKE_PINS, { ...SETTINGS, replyMode: { claude: 'shout', dsh: 'direct', codex: 'direct' } })),
      "the kept config.json fails this version's checks"],
    ['no file', null, 'the kept private root has no config.json'],
  ];
  for (const [name, text, reason] of cases) {
    const f = await fixture();
    try {
      await f.keptRoot(text);
      const plan = await planInstall(f.env);
      const lines = [`settings back to defaults (${reason}):`, ...DEFAULT_LINES];
      assert.ok(describePlan(plan, f.env.paths).includes(lines.map(line => `    ${line}`).join('\n')), name);
      assert.ok((await applyInstall(plan, f.env)).includes(lines.join('\n')), name);
      assert.deepEqual(JSON.parse(await readFile(f.config, 'utf8')), fileOf(FAKE_PINS, DEFAULTS), name);
      assert.equal(await readFile(join(f.env.paths.root, 'state', 'directory.json'), 'utf8'), 'kept', name);
    } finally { await f.cleanup(); }
  }
});

test('a fresh install names no carried-over settings', async () => {
  const f = await fixture();
  try {
    const plan = await planInstall(f.env);
    assert.doesNotMatch(describePlan(plan, f.env.paths), /settings (kept|back to defaults)/);
    assert.doesNotMatch(await applyInstall(plan, f.env), /settings (kept|back to defaults)/);
  } finally { await f.cleanup(); }
});

test('a failed install over kept data puts config.json back byte for byte and keeps state/', async () => {
  const failing: ClaudeStep = { lines: [], apply: async () => { throw new Error('boom'); } };
  const f = await fixture(failing);
  try {
    const text = `${JSON.stringify(fileOf(FAKE_PINS, SETTINGS), null, 4)}\n\n`;
    await f.keptRoot(text);
    await assert.rejects(applyInstall(await planInstall(f.env), f.env), { code: 'INSTALL_FAILED' });
    assert.deepEqual((await readdir(f.env.paths.root)).sort(), ['config.json', 'state']);
    assert.equal(await readFile(f.config, 'utf8'), text);
    assert.equal(await readFile(join(f.env.paths.root, 'state', 'directory.json'), 'utf8'), 'kept');
  } finally { await f.cleanup(); }
});

test('a kept config.json that is not a plain file blocks install before anything is written', async () => {
  const f = await fixture();
  try {
    await f.keptRoot(null);
    await writeFile(join(f.env.paths.root, 'elsewhere.json'), '{}');
    await symlink(join(f.env.paths.root, 'elsewhere.json'), f.config);
    await rm(join(f.env.paths.root, 'elsewhere.json'));
    await assert.rejects(planInstall(f.env), { code: 'INSTALL_PRECONDITION_FAILED', detail: `not a regular file: ${f.config}` });
    assert.deepEqual((await readdir(f.env.paths.root)).sort(), ['config.json', 'state']);
  } finally { await f.cleanup(); }
});
