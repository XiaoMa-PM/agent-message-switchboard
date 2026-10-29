// INPUT: A fake package with a stub src/cli/entry.ts, temp HOME and directories, a fake installed bundle and output sinks.
// OUTPUT: The npm launcher: --version, help, upgrade, platform and Node gates, staged install, commands handed to the bundle.
// POS: Offline launcher tests; the stub entry stands in for the TypeScript CLI, no real install runs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runLauncher, type LauncherDeps } from '../../src/cli/launcher.mjs';
import { snapshotTree } from './install-fixture.ts';

const STUB = `import { existsSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const record = args[args.indexOf('--record') + 1];
writeFileSync(record, JSON.stringify({ args, at: import.meta.dirname, prod: existsSync(new URL('../../node_modules/prod/index.js', import.meta.url)),
  dev: existsSync(new URL('../../node_modules/devonly', import.meta.url)) }));
process.exitCode = args.includes('--fail') ? 7 : 0;
`;

async function fixture() {
  const base = await realpath(await mkdtemp('/tmp/ms-launch-'));
  const pkg = join(base, 'lib', 'node_modules', 'agent-message-switchboard');
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'agent-message-switchboard', version: '9.9.9', type: 'module' }),
    'npm-shrinkwrap.json': JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/prod': {}, 'node_modules/devonly': { dev: true },
      'node_modules/absent-optional': { optional: true } } }),
    'src/cli/entry.ts': STUB, 'plugins/ms-dsh/index.mjs': '', 'node_modules/prod/index.js': '', 'node_modules/devonly/index.js': '',
    'tests/ignored.test.ts': '',
  };
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(pkg, name, '..'), { recursive: true });
    await writeFile(join(pkg, name), text);
  }
  const home = join(base, 'home');
  const tmp = join(base, 'tmp');
  await mkdir(home); await mkdir(tmp);
  const out: string[] = [];
  const err: string[] = [];
  const deps = (argv: string[], extra: Partial<LauncherDeps> = {}): LauncherDeps => ({ argv, home, tmpdir: tmp, packageRoot: pkg,
    execPath: process.execPath, nodeVersion: '24.16.0', platform: 'darwin', arch: 'arm64', out: text => out.push(text), err: text => err.push(text), ...extra });
  const record = join(base, 'record.json');
  const recorded = async () => JSON.parse(await readFile(record, 'utf8'));
  return { base, pkg, home, tmp, out, err, deps, record, recorded, cleanup: () => rm(base, { recursive: true, force: true }) };
}

const rootOf = (home: string) => join(home, 'Library', 'Application Support', 'agent-message-switchboard');

async function installBundle(home: string, version: string, bundle = join(rootOf(home), 'bundles', 'abc')): Promise<string> {
  await mkdir(join(bundle, 'runtime'), { recursive: true });
  await mkdir(join(bundle, 'src', 'cli'), { recursive: true });
  await mkdir(join(home, 'Library', 'Application Support', 'agent-message-switchboard', 'install'), { recursive: true });
  await writeFile(join(bundle, 'package.json'), JSON.stringify({ version, type: 'module' }));
  await writeFile(join(bundle, 'runtime', 'node'), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`);
  await chmod(join(bundle, 'runtime', 'node'), 0o755);
  await writeFile(join(bundle, 'src', 'cli', 'entry.ts'), STUB);
  await writeFile(join(home, 'Library', 'Application Support', 'agent-message-switchboard', 'install', 'manifest.json'),
    JSON.stringify({ schemaVersion: 1, state: 'installed', bundle: { path: bundle, digest: 'x', files: 1 }, records: [] }));
  return bundle;
}

test('install --dry-run stages runtime files in a fresh temp directory, leaves HOME byte-identical and removes the copy', async () => {
  const f = await fixture();
  try {
    const before = await snapshotTree(f.home);
    assert.equal(await runLauncher(f.deps(['install', '--dry-run', '--record', f.record])), 0);
    const ran = await f.recorded();
    assert.deepEqual(ran.args, ['install', '--dry-run', '--record', f.record]);
    assert.ok(ran.at.startsWith(join(f.tmp, 'ms-stage-')), ran.at);
    assert.deepEqual([ran.prod, ran.dev], [true, false]);
    assert.deepEqual(await snapshotTree(f.home), before);
    assert.deepEqual(await readdir(f.tmp), []);
  } finally { await f.cleanup(); }
});

test('upgrade stages the package like install, runs upgrade there, keeps its exit code and removes the copy either way', async () => {
  const f = await fixture();
  try {
    await installBundle(f.home, '1.0.0');
    assert.equal(await runLauncher(f.deps(['upgrade', '--record', f.record])), 0);
    const ran = await f.recorded();
    assert.deepEqual(ran.args, ['upgrade', '--record', f.record]);
    assert.ok(ran.at.startsWith(join(f.tmp, 'ms-stage-')), ran.at);
    assert.deepEqual(await readdir(f.tmp), []);
    assert.equal(await runLauncher(f.deps(['upgrade', '--fail', '--record', f.record])), 7);
    assert.deepEqual(await readdir(f.tmp), []);
    assert.equal(await runLauncher(f.deps(['upgrade', '--dry-run', '--record', f.record])), 0);
    assert.deepEqual((await f.recorded()).args, ['upgrade', '--dry-run', '--record', f.record]);
    assert.deepEqual(await readdir(f.tmp), []);
    assert.deepEqual(f.err, []);
  } finally { await f.cleanup(); }
});

test('a failing install keeps its exit code and still removes the staging copy', async () => {
  const f = await fixture();
  try {
    assert.equal(await runLauncher(f.deps(['install', '--fail', '--record', f.record])), 7);
    assert.deepEqual(await readdir(f.tmp), []);
    await rm(join(f.pkg, 'src'), { recursive: true });
    assert.equal(await runLauncher(f.deps(['install'])), 5);
    assert.match(f.err.at(-1)!, /^ms: MS_STAGING_FAILED /);
    assert.deepEqual(await readdir(f.tmp), []);
  } finally { await f.cleanup(); }
});

test('install and upgrade refuse a Node outside 24.16 to 24.x before staging anything', async () => {
  const f = await fixture();
  try {
    for (const version of ['24.15.1', '25.0.0', '22.12.0', '26.1.0']) {
      for (const command of ['install', 'upgrade']) {
        assert.equal(await runLauncher(f.deps([command], { nodeVersion: version })), 5, version);
        assert.equal(f.err.at(-1), `ms: MS_NODE_UNSUPPORTED (ms needs Node 24.16 or a later 24.x, this is Node ${version}; install Node 24 LTS, then rerun ms ${command})`);
      }
    }
    assert.deepEqual(await readdir(f.tmp), []);
    assert.equal(await runLauncher(f.deps(['install', '--dry-run', '--record', f.record], { nodeVersion: '24.20.3' })), 0);
  } finally { await f.cleanup(); }
});

test('install and upgrade refuse anything but macOS on Apple Silicon before staging; --version and help do not check', async () => {
  const f = await fixture();
  try {
    for (const [platform, arch] of [['linux', 'x64'], ['linux', 'arm64'], ['darwin', 'x64'], ['win32', 'x64']]) {
      for (const command of ['install', 'upgrade']) {
        assert.equal(await runLauncher(f.deps([command, '--dry-run'], { platform, arch, nodeVersion: '22.12.0' })), 5, `${command} ${platform} ${arch}`);
        assert.equal(f.err.at(-1), `ms: MS_PLATFORM_UNSUPPORTED (this version supports only macOS on Apple Silicon, darwin arm64; this is ${platform} ${arch})`);
      }
      assert.equal(await runLauncher(f.deps(['--version'], { platform, arch })), 0);
      assert.equal(await runLauncher(f.deps(['help'], { platform, arch })), 0);
    }
    assert.deepEqual(await readdir(f.tmp), []);
  } finally { await f.cleanup(); }
});

test('a temp directory under HOME or under node_modules is refused, and the staging copy is still removed', async () => {
  const f = await fixture();
  try {
    for (const [tmp, reason] of [[join(f.home, 'tmp'), 'is under HOME'], [join(f.base, 'node_modules', 'tmp'), 'is under a node_modules directory']]) {
      await mkdir(tmp, { recursive: true });
      assert.equal(await runLauncher(f.deps(['install', '--dry-run'], { tmpdir: tmp })), 5, tmp);
      assert.match(f.err.at(-1)!, new RegExp(`^ms: MS_STAGING_UNSAFE \\(${tmp}/ms-stage-\\S+ ${reason}; `));
      assert.deepEqual(await readdir(tmp), [], tmp);
    }
  } finally { await f.cleanup(); }
});

test('--version names the package and the installed version; help and other commands need an install', async () => {
  const f = await fixture();
  try {
    assert.equal(await runLauncher(f.deps(['--version'])), 0);
    assert.deepEqual(f.out, ['ms 9.9.9', 'installed: none']);
    assert.equal(await runLauncher(f.deps(['help'])), 0);
    assert.match(f.out.at(-1)!, /^usage: ms <command>\n {2}install \[--dry-run\]/);
    assert.equal(await runLauncher(f.deps(['status'])), 5);
    assert.equal(f.err.at(-1), 'ms: NOT_INSTALLED (run `ms install`)');
  } finally { await f.cleanup(); }
});

test('the installed bundle runs only when its Node and CLI resolve inside the private root bundles/', async () => {
  const setups: Record<string, (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>> = {
    'a ledger naming a bundle outside bundles/': async f => { await installBundle(f.home, '9.9.9', join(f.base, 'elsewhere', 'abc')); },
    'a ledger naming a missing bundle': async f => { await rm(await installBundle(f.home, '9.9.9'), { recursive: true }); },
    'a runtime/node linking outside bundles/': async f => {
      const node = join(await installBundle(f.home, '9.9.9'), 'runtime', 'node');
      await rm(node);
      await symlink(process.execPath, node);
    },
    'a bundles/ directory linking elsewhere': async f => {
      await installBundle(f.home, '9.9.9', join(f.base, 'elsewhere', 'abc'));
      await symlink(join(f.base, 'elsewhere'), join(rootOf(f.home), 'bundles'));
      const manifest = join(rootOf(f.home), 'install', 'manifest.json');
      await writeFile(manifest, (await readFile(manifest, 'utf8')).replace(join(f.base, 'elsewhere'), join(rootOf(f.home), 'bundles')));
    },
  };
  for (const [name, setup] of Object.entries(setups)) {
    const f = await fixture();
    try {
      await setup(f);
      assert.equal(await runLauncher(f.deps(['status', '--record', f.record])), 5, name);
      assert.match(f.err.at(-1)!, /^ms: MS_BUNDLE_OUTSIDE_ROOT \(the install ledger names .+ whose runtime\/node or src\/cli\/entry\.ts does not resolve inside /, name);
      assert.equal(existsSync(f.record), false, name);
    } finally { await f.cleanup(); }
  }
});

test('other commands run the installed bundle, after one note when its version differs from the package', async () => {
  const f = await fixture();
  try {
    const bundle = await installBundle(f.home, '9.9.9');
    assert.equal(await runLauncher(f.deps(['status', '--record', f.record])), 0);
    assert.equal((await f.recorded()).at, join(bundle, 'src', 'cli'));
    assert.deepEqual(f.err, []);
    await writeFile(join(bundle, 'package.json'), JSON.stringify({ version: '1.0.0', type: 'module' }));
    assert.equal(await runLauncher(f.deps(['sessions', '--fail', '--record', f.record])), 7);
    assert.deepEqual(f.err, ["ms: installed 1.0.0 differs from this package's 9.9.9; running the installed one (ms upgrade switches to 9.9.9)"]);
    assert.equal(await runLauncher(f.deps(['--version'])), 0);
    assert.deepEqual(f.out.slice(-2), ['ms 9.9.9', 'installed: 1.0.0']);
  } finally { await f.cleanup(); }
});
