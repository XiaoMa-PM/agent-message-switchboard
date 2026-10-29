// INPUT: Temp HOME holding a real 1.0.0 install, a 1.0.1 fixture package, a fake old CLI, a fake msd control and an output sink.
// OUTPUT: ms upgrade: step order, settings and state carried over, follow-up lines, same version and downgrade, --dry-run, failures.
// POS: Offline upgrade tests; never touches the real HOME, launchd, Claude, DSH or Codex.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CliError } from '../../src/cli/errors.ts';
import { planInstall, type ClaudeStep } from '../../src/cli/install.ts';
import { applyInstall } from '../../src/cli/install-apply.ts';
import { writeManifest } from '../../src/cli/manifest.ts';
import { applyUninstall, loadManifest } from '../../src/cli/uninstall.ts';
import { runUpgrade, systemRun, type RunOld, type UpgradeDeps } from '../../src/cli/upgrade.ts';
import { STUB_CLAUDE, makeEnv, makeHome, makeSource, recordingLaunchctl, snapshotTree } from './install-fixture.ts';

type Options = Readonly<{ from?: string; to?: string; claude?: ClaudeStep; oldFails?: string; startFails?: boolean; dropConfig?: boolean }>;

async function source(version: string) {
  const made = await makeSource();
  await writeFile(join(made.root, 'package.json'), JSON.stringify({ type: 'module', version }));
  await writeFile(join(made.root, 'src', 'cli', 'entry.ts'), `// cli ${version}\n`);
  await mkdir(join(made.root, 'src', 'adapters', 'codex'), { recursive: true });
  await writeFile(join(made.root, 'src', 'adapters', 'codex', 'mcp-main.ts'), '// adapter\n');
  return made;
}

async function fixture(options: Options = {}) {
  const home = await makeHome();
  await mkdir(join(home, '.codex', '.tmp', 'marketplaces'), { recursive: true });
  await mkdir(join(home, '.codex', 'tmp', 'arg0-macos'), { recursive: true });
  await writeFile(join(home, '.codex', 'config.toml'), '[projects."/tmp/x"]\ntrust_level = "trusted"\n', { mode: 0o600 });
  const [from, to] = [await source(options.from ?? '1.0.0'), await source(options.to ?? '1.0.1')];
  const before = makeEnv(home, from);
  await applyInstall(await planInstall(before), before);
  await mkdir(join(before.paths.root, 'state'), { mode: 0o700 });
  await writeFile(join(before.paths.root, 'state', 'directory.json'), 'kept');
  const oldBundle = (await loadManifest(before.paths)).bundle!.path;
  const env = makeEnv(home, to, options.claude ?? STUB_CLAUDE);
  const events: string[] = [];
  const out: string[] = [];
  const runOld: RunOld = async (command, args) => {
    const step = args.slice(1).join(' ');
    events.push(`old ${step}`);
    assert.deepEqual([command, args[0]], [join(oldBundle, 'runtime', 'node'), join(oldBundle, 'src', 'cli', 'entry.ts')]);
    if (options.oldFails === step) return { code: 6, stdout: '', stderr: 'ms: UNINSTALL_CONFLICT: something changed' };
    if (step !== 'uninstall --keep-data') return { code: 0, stdout: 'usage: ms <command>\n', stderr: '' };
    const deps = { paths: env.paths, launchctl: recordingLaunchctl().launchctl, uid: 501, dshPnpm: env.dshPnpm, claudeCli: env.claudeCli, codexCli: env.codexCli };
    const stdout = await applyUninstall(await loadManifest(env.paths), deps, true);
    if (options.dropConfig) await rm(join(env.paths.root, 'config.json'));
    return { code: 0, stdout: `${stdout}\n`, stderr: '' };
  };
  const daemon = async (action: 'start' | 'stop') => {
    events.push(`msd ${action} (ledger ${existsSync(env.paths.manifest) ? 'present' : 'absent'})`);
    if (action === 'start' && options.startFails) throw new CliError('DAEMON_START_TIMEOUT', 'see msd.err.log');
    return action === 'stop' ? 'msd stopped' : 'msd 1.0.1 started\nlaunchd: loaded, state running, pid 42';
  };
  const deps: UpgradeDeps = { env, daemon, runOld, out: text => out.push(text) };
  const cleanup = async () => { for (const dir of [home, from.root, to.root]) await rm(dir, { recursive: true, force: true }); };
  return { home, env, deps, events, out, oldBundle, cleanup };
}

const FOLLOW_UPS = [
  'next:',
  '  DSH: restart DSH once so it loads the new plugin',
  '  Claude Code: in Claude sessions that are already open, run /reload-plugins',
  '  Codex: start a new Codex session and trust all six ms hooks again in /hooks; until UserPromptSubmit, PreToolUse and '
    + 'PermissionRequest are trusted, act letters are handled as direct',
];

test('upgrade checks first, stops msd, has the old CLI uninstall itself with --keep-data, installs, starts msd and lists follow-ups', async () => {
  const f = await fixture();
  try {
    const config = join(f.env.paths.root, 'config.json');
    const settings = { ...JSON.parse(await readFile(config, 'utf8')), replyMode: { claude: 'confirm', dsh: 'direct', codex: 'act' } };
    await writeFile(config, JSON.stringify(settings), { mode: 0o600 });
    const result = await runUpgrade(f.deps);
    assert.deepEqual(f.events, ['old help', 'msd stop (ledger present)', 'old uninstall --keep-data', 'msd start (ledger present)']);
    assert.deepEqual(result.split('\n'), ['ms upgraded 1.0.0 → 1.0.1', ...FOLLOW_UPS]);
    const lines = f.out.join('\n').split('\n');
    assert.equal(lines[0], 'ms upgrade: 1.0.0 → 1.0.1');
    assert.equal(lines[1], 'stop msd: msd stopped');
    assert.equal(lines[2], 'uninstall 1.0.0 with its own CLI (ms uninstall --keep-data):');
    assert.equal(lines[3], '  ms uninstalled');
    const install = lines.indexOf('install 1.0.1:');
    assert.ok(install > 3 && lines[install + 1].startsWith('  ms installed: '));
    assert.ok(lines.includes('  settings kept from the previous config.json: autoRegister, autoRegisterProjects, replyMode, actPreset, linkBudget (Python pin re-detected)'));
    assert.ok(!lines.includes('  next: ms daemon start'));
    assert.deepEqual(lines.slice(-3), ['start msd:', '  msd 1.0.1 started', '  launchd: loaded, state running, pid 42']);
    const manifest = await loadManifest(f.env.paths);
    assert.notEqual(manifest.bundle!.path, f.oldBundle);
    assert.equal(existsSync(f.oldBundle), false);
    assert.deepEqual(JSON.parse(await readFile(config, 'utf8')).replyMode, settings.replyMode);
    assert.equal(await readFile(join(f.env.paths.root, 'state', 'directory.json'), 'utf8'), 'kept');
  } finally { await f.cleanup(); }
});

test('follow-up lines name only the harnesses the new version installed', async () => {
  const f = await fixture();
  try {
    const planClaude = async () => { throw new CliError('INSTALL_PRECONDITION_FAILED', 'claude not on PATH'); };
    const result = await runUpgrade({ ...f.deps, env: { ...f.env, planClaude } });
    assert.deepEqual(result.split('\n'), ['ms upgraded 1.0.0 → 1.0.1', FOLLOW_UPS[0], FOLLOW_UPS[1], FOLLOW_UPS[3]]);
  } finally { await f.cleanup(); }
});

test('an old version whose --keep-data dropped config.json upgrades with every setting named back to its default', async () => {
  const f = await fixture({ dropConfig: true });
  try {
    await runUpgrade(f.deps);
    assert.ok(f.out.join('\n').includes('  settings back to defaults (the kept private root has no config.json):\n    autoRegister: off for every harness'));
  } finally { await f.cleanup(); }
});

test('the same version reinstalls and a lower one downgrades, each said on the first line', async () => {
  for (const [from, to, note] of [['1.0.0', '1.0.0', ' (reinstall of the same version)'], ['1.2.0', '1.0.10', ' (downgrade)'], ['1.0.9', '1.0.10', '']]) {
    const f = await fixture({ from, to });
    try {
      await runUpgrade(f.deps);
      assert.equal(f.out[0], `ms upgrade: ${from} → ${to}${note}`);
    } finally { await f.cleanup(); }
  }
});

test('a failed preflight changes nothing: no msd stop, no uninstall, HOME byte-identical', async () => {
  const cases: Record<string, (f: Awaited<ReturnType<typeof fixture>>) => Promise<string | RegExp>> = {
    'Python not found': async f => {
      f.deps = { ...f.deps, env: { ...f.env, discoverPins: async () => { throw new CliError('INSTALL_PRECONDITION_FAILED', 'python3.13 not found'); } } };
      return 'INSTALL_PRECONDITION_FAILED: python3.13 not found; nothing was changed';
    },
    'old CLI does not run': async f => {
      const runOld = f.deps.runOld;
      f.deps = { ...f.deps, runOld: async (command, args) => (args[1] === 'help' ? { code: 137, stdout: '', stderr: 'Killed' } : runOld(command, args)) };
      return /^the installed 1\.0\.0 cannot run its own CLI \(help exited 137: Killed\); it has to uninstall itself first: fix what ".+\/bin\/ms" help reports, then rerun ms upgrade; nothing was changed$/;
    },
    'ledger in conflict': async f => {
      await writeManifest(f.env.paths.manifest, { ...(await loadManifest(f.env.paths)), state: 'conflict' });
      return 'the install ledger is in state conflict; resolve it with ms uninstall first, then ms install; nothing was changed';
    },
    'bundle outside bundles/': async f => {
      const manifest = await loadManifest(f.env.paths);
      await writeManifest(f.env.paths.manifest, { ...manifest, bundle: { ...manifest.bundle!, path: '/opt/elsewhere' } });
      return /^the install ledger names \/opt\/elsewhere, whose runtime\/node or src\/cli\/entry\.ts does not resolve inside .+\/bundles; nothing was changed$/;
    },
    'run from the installed copy': async f => {
      f.deps = { ...f.deps, env: { ...f.env, sourceRoot: f.oldBundle } };
      return /^this is the installed copy at .+; run ms upgrade from the npm package \(npm i -g agent-message-switchboard@latest, then ms upgrade\); nothing was changed$/;
    },
    'config.json not a plain file': async f => {
      const config = join(f.env.paths.root, 'config.json');
      await rm(config);
      await symlink('/etc/hosts', config);
      return `INSTALL_PRECONDITION_FAILED: not a regular file: ${config}; nothing was changed`;
    },
  };
  for (const [name, setup] of Object.entries(cases)) {
    for (const dryRun of [false, true]) {
      const f = await fixture();
      try {
        const detail = await setup(f);
        const before = await snapshotTree(f.home);
        await assert.rejects(runUpgrade(f.deps, dryRun), (error: CliError) => {
          assert.equal(error.code, 'MS_UPGRADE_PRECONDITION_FAILED', name);
          if (typeof detail === 'string') assert.equal(error.detail, detail, name);
          else assert.match(error.detail!, detail, name);
          return true;
        });
        assert.deepEqual(await snapshotTree(f.home), before, name);
        assert.ok(f.events.every(event => event === 'old help'), name);
        assert.deepEqual(f.out, [], name);
      } finally { await f.cleanup(); }
    }
  }
});

test('upgrade --dry-run prints the preflight, the settings outcome and every step, and stops, uninstalls and writes nothing', async () => {
  const f = await fixture();
  try {
    const before = await snapshotTree(f.home);
    const lines = (await runUpgrade(f.deps, true)).split('\n');
    assert.deepEqual(f.events, ['old help']);
    assert.deepEqual(f.out, []);
    assert.deepEqual(await snapshotTree(f.home), before);
    assert.deepEqual(lines.slice(0, 3), ['ms upgrade plan (dry run, nothing written): 1.0.0 → 1.0.1',
      '  preflight passed: socket paths, install ledger, installed bundle and its CLI, Python pin, new package, config.json', '  stop msd']);
    assert.match(lines[3], /^ {2}run 1\.0\.0's own ms uninstall --keep-data, which keeps state\/ and config\.json \(its own plan: ".+\/bin\/ms" uninstall --dry-run --keep-data\)$/);
    assert.equal(lines[4], '  install 1.0.1:');
    assert.match(lines[5], /^ {4}copy bundle .+\/bundles\/[0-9a-f]{16} \(\d+ files, \d+ bytes, sha256 [0-9a-f]{64}\)$/);
    assert.match(lines[6], /^ {4}write .+\/config\.json \(0600: pins below\)$/);
    assert.deepEqual(lines.slice(7, 10), [
      '    pin python /opt/python/Python.app/Contents/MacOS/Python (aaaaaaaaaaaa)',
      '    settings kept from the previous config.json: autoRegister, autoRegisterProjects, replyMode, actPreset, linkBudget (Python pin re-detected)',
      "    (as long as 1.0.0's uninstall --keep-data keeps config.json; an older one that drops it leaves every setting at its default)"]);
    assert.deepEqual(lines.slice(10), [
      '    then the LaunchAgent, the fallback launcher and the DSH, Claude Code and Codex plugins, each planned once 1.0.0 is gone; '
        + 'a harness whose preconditions fail then is skipped with a manual-install pointer',
      '  start msd', '  then list the follow-up steps for each harness installed']);
  } finally { await f.cleanup(); }
});

test('upgrade --dry-run names each setting that would go back to its default', async () => {
  const f = await fixture();
  try {
    const config = join(f.env.paths.root, 'config.json');
    await writeFile(config, JSON.stringify({ ...JSON.parse(await readFile(config, 'utf8')), schemaVersion: 3 }));
    const text = await runUpgrade(f.deps, true);
    assert.ok(text.includes(['    settings back to defaults (the kept config.json has schemaVersion 3, this version uses 4):',
      '      autoRegister: off for every harness', '      autoRegisterProjects: empty (every project)', '      replyMode: direct for every harness',
      '      actPreset: workspace-write for every harness', '      linkBudget: 30 pushes per 600 s',
      '    then the LaunchAgent'].join('\n')));
  } finally { await f.cleanup(); }
});

test('with nothing installed, upgrade says to use ms install', async () => {
  const f = await fixture();
  try {
    await rm(f.env.paths.manifest);
    await assert.rejects(runUpgrade(f.deps), { code: 'NOT_INSTALLED', detail: 'nothing to upgrade; run ms install' });
    assert.deepEqual(f.events, []);
  } finally { await f.cleanup(); }
});

test('an old uninstall that fails stops the upgrade with manual steps; nothing is installed and msd is not started', async () => {
  const f = await fixture({ oldFails: 'uninstall --keep-data' });
  try {
    await assert.rejects(runUpgrade(f.deps), (error: CliError) => {
      assert.equal(error.code, 'MS_UPGRADE_UNINSTALL_FAILED');
      assert.match(error.detail!, /^1\.0\.0's uninstall --keep-data exited 6: ms: UNINSTALL_CONFLICT: something changed\nmsd is stopped and 1\.0\.0 may be partly removed; state\/ and config\.json are kept\. Resolve what it reports, rerun ".+\/bin\/ms" uninstall --keep-data, then ms install$/);
      return true;
    });
    assert.deepEqual(f.events, ['old help', 'msd stop (ledger present)', 'old uninstall --keep-data']);
  } finally { await f.cleanup(); }
});

test('a new install that fails leaves no version installed, keeps state/ and config.json and says how to recover', async () => {
  const failing: ClaudeStep = { lines: [], apply: async () => { throw new CliError('CLAUDE_CLI_FAILED', 'plugin install exit 1'); } };
  const f = await fixture({ claude: failing });
  try {
    const config = await readFile(join(f.env.paths.root, 'config.json'));
    await assert.rejects(runUpgrade(f.deps), (error: CliError) => {
      assert.equal(error.code, 'MS_UPGRADE_INSTALL_FAILED');
      assert.equal(error.detail, 'INSTALL_FAILED: CLAUDE_CLI_FAILED: plugin install exit 1\nno version of ms is installed now; '
        + `what uninstall --keep-data kept in ${f.env.paths.root} (state/, config.json) is still there. To recover: run ms install `
        + 'again once the cause is fixed, or go back with npm i -g agent-message-switchboard@1.0.0 and ms install');
      return true;
    });
    assert.equal(existsSync(f.env.paths.manifest), false);
    assert.deepEqual(await readFile(join(f.env.paths.root, 'config.json')), config);
    assert.equal(await readFile(join(f.env.paths.root, 'state', 'directory.json'), 'utf8'), 'kept');
    assert.deepEqual(f.events, ['old help', 'msd stop (ledger present)', 'old uninstall --keep-data']);
  } finally { await f.cleanup(); }
});

test('msd that does not start after the install is MS_UPGRADE_START_FAILED with the new version installed', async () => {
  const f = await fixture({ startFails: true });
  try {
    await assert.rejects(runUpgrade(f.deps), {
      code: 'MS_UPGRADE_START_FAILED', detail: 'DAEMON_START_TIMEOUT: see msd.err.log\n1.0.1 is installed; once the cause is fixed, run ms daemon start' });
    assert.equal((await loadManifest(f.env.paths)).state, 'installed');
  } finally { await f.cleanup(); }
});

test('systemRun returns the exit code and both streams of a real child', async () => {
  const script = 'process.stdout.write("out"); process.stderr.write("err"); process.exitCode = 3;';
  assert.deepEqual(await systemRun(process.execPath, ['-e', script]), { code: 3, stdout: 'out', stderr: 'err' });
  assert.equal((await systemRun('/nonexistent/node', [])).code, 127);
});
