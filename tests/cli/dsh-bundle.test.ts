// INPUT: Temp HOME with a DSH desktop profile, fakeDshPnpm and a fake DeepSeek Harness.app tree.
// OUTPUT: DSH bundle regressions: pnpm argv, ledger, exact restore, pnpm-remove fallback, the link pnpm remove leaves
//         (removed only when it is ms's, else a kept conflict), an interrupted install (no afterSha: structural removal or no-op,
//         never the backups), override-row cleanup, preconditions and the real runner's argv/env.
// POS: Offline tests for the DSH install step; never runs DSH or its pnpm.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DSH_PACKAGE, systemDshPnpm } from '../../src/cli/dsh-bundle.ts';
import type { CliError } from '../../src/cli/errors.ts';
import { sha256 } from '../../src/cli/fs-ops.ts';
import { restoreExact } from '../../src/cli/revert-file.ts';
import { describePlan, planInstall, type ClaudeStep } from '../../src/cli/install.ts';
import { applyInstall } from '../../src/cli/install-apply.ts';
import { applyUninstall, describeUninstall, loadManifest } from '../../src/cli/uninstall.ts';
import { DESKTOP_PATCH, PROFILE_PACKAGE, STUB_CLAUDE, fakeDshPnpm, interruptLedger, makeEnv, makeHome, makeSource, recordingLaunchctl, snapshotTree,
  type FakePnpm } from './install-fixture.ts';

const ID = 'ms-dsh-client';

async function fixture(claude: ClaudeStep = STUB_CLAUDE) {
  const home = await makeHome();
  const source = await makeSource();
  const fake = fakeDshPnpm();
  const env = makeEnv(home, source, claude, fake.pnpm);
  const profile = join(home, '.dsh', 'profiles', 'desktop');
  const cleanup = async () => { await rm(home, { recursive: true, force: true }); await rm(source.root, { recursive: true, force: true }); };
  return { home, env, fake, profile, cleanup };
}

function deps(env: ReturnType<typeof makeEnv>, fake: FakePnpm) {
  return { paths: env.paths, launchctl: recordingLaunchctl().launchctl, uid: 501, dshPnpm: fake.pnpm, claudeCli: env.claudeCli, codexCli: env.codexCli };
}

async function manifestOf(profile: string) { return JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')); }

async function otherBundle(home: string, profile: string, fake: FakePnpm): Promise<void> {
  await mkdir(join(home, 'third'));
  await writeFile(join(home, 'third', 'package.json'), '{"name":"third-bundle"}\n');
  await fake.pnpm.run(profile, ['add', `link:${join(home, 'third')}`, '--save-exact']);
  const manifest = await manifestOf(profile);
  manifest.dsh.profile.bundles.push('third-bundle');
  await writeFile(join(profile, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

test('install adds the bundle with DSH pnpm add link: --save-exact, appends it to bundles and journals both files', async () => {
  const { env, fake, profile, cleanup } = await fixture();
  try {
    const plan = await planInstall(env);
    const spec = `link:${plan.bundleDir}/plugins/ms-dsh`;
    const dry = describePlan(plan, env.paths);
    for (const fragment of [`DSH pnpm add ${spec} --save-exact`, 'dsh.profile.bundles', 'restart DSH']) assert.ok(dry.includes(fragment), fragment);
    assert.deepEqual(fake.calls, []);
    const out = await applyInstall(plan, env);
    assert.match(out, /restart DSH/);
    assert.deepEqual(fake.calls, [['add', spec, '--save-exact']]);
    const text = await readFile(join(profile, 'package.json'), 'utf8');
    assert.equal(text, `${JSON.stringify(JSON.parse(text), null, 2)}\n`);
    assert.equal((await stat(join(profile, 'package.json'))).mode & 0o777, 0o600);
    assert.equal(JSON.parse(text).dependencies[DSH_PACKAGE], spec);
    assert.deepEqual(JSON.parse(text).dsh.profile.bundles, ['other-bundle', DSH_PACKAGE]);
    const link = join(profile, 'node_modules', DSH_PACKAGE);
    assert.equal(resolve(await realpath(dirname(link)), await readlink(link)), `${plan.bundleDir}/plugins/ms-dsh`);
    assert.equal(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'), DESKTOP_PATCH);
    const record = (await loadManifest(env.paths)).records.find(item => item.kind === 'dsh-bundle');
    assert.ok(record && record.kind === 'dsh-bundle');
    assert.equal(record.packageJson.beforeSha, sha256(PROFILE_PACKAGE));
    assert.equal(record.packageJson.afterSha, sha256(text));
    assert.equal(record.pnpmLock.afterSha, sha256(await readFile(join(profile, 'pnpm-lock.yaml'))));
    assert.equal(await readFile(record.packageJson.backup!, 'utf8'), PROFILE_PACKAGE);
    assert.deepEqual([record.packageName, record.target, record.link], [DSH_PACKAGE, `${plan.bundleDir}/plugins/ms-dsh`, link]);
    assert.match(describeUninstall(await loadManifest(env.paths), env.paths, false), /remove agent-message-switchboard-dsh from DSH profile/);
  } finally { await cleanup(); }
});

test('uninstall of an untouched profile takes ours out of bundles, runs pnpm remove, then restores both files byte for byte', async () => {
  for (const label of ['lock present', 'no lock before install']) {
    const { home, env, fake, profile, cleanup } = await fixture();
    try {
      if (label === 'no lock before install') await rm(join(profile, 'pnpm-lock.yaml'));
      const before = await snapshotTree(home);
      await applyInstall(await planInstall(env), env);
      const out = await applyUninstall(await loadManifest(env.paths), deps(env, fake), false);
      assert.match(out, /restart DSH/);
      assert.match(out, /restored exactly/);
      assert.deepEqual(fake.calls.map(call => call[0]), ['add', 'remove'], label);
      assert.deepEqual(fake.bundlesAt.at(-1), ['other-bundle'], `${label}: bundles before pnpm remove`);
      assert.deepEqual(await snapshotTree(home), before, label);
    } finally { await cleanup(); }
  }
});

test('uninstall removes the link pnpm remove leaves under DSH\'s hoisted node_modules, written relative to the real profile path', async () => {
  const { home, env, fake, profile, cleanup } = await fixture();
  try {
    const before = await snapshotTree(home);
    await applyInstall(await planInstall(env), env);
    const link = join(profile, 'node_modules', DSH_PACKAGE);
    const target = (await loadManifest(env.paths)).records.find(record => record.kind === 'dsh-bundle')!.target;
    assert.notEqual(resolve(dirname(link), await readlink(link)), target, 'the lexical ~/.dsh path misses the real target');
    const out = await applyUninstall(await loadManifest(env.paths), deps(env, fake), false);
    assert.match(out, new RegExp(`\\nok ${DSH_PACKAGE}: removed with DSH pnpm; .*restored exactly; ${link}: removed\\n`));
    await assert.rejects(readlink(link), { code: 'ENOENT' });
    assert.deepEqual(await snapshotTree(home), before);
  } finally { await cleanup(); }
});

test('a link that is not ms\'s, or that will not go, is a kept conflict that never reports ok; a rerun finishes once it is gone', async () => {
  const cases: Record<string, (link: string) => Promise<() => Promise<void>>> = {
    'link elsewhere': async link => { await rm(link); await symlink('/opt/other-bundle', link); return () => rm(link); },
    'plain directory': async link => { await rm(link); await mkdir(link); return () => rm(link, { recursive: true }); },
    'not removable': async link => {
      const mode = (await stat(dirname(link))).mode & 0o777;
      await chmod(dirname(link), 0o555);
      return () => chmod(dirname(link), mode);
    },
  };
  for (const [label, prepare] of Object.entries(cases)) {
    const { home, env, fake, profile, cleanup } = await fixture();
    try {
      const before = await snapshotTree(home);
      await applyInstall(await planInstall(env), env);
      const link = join(profile, 'node_modules', DSH_PACKAGE);
      const settle = await prepare(link);
      const kept = await snapshotTree(dirname(link));
      await assert.rejects(applyUninstall(await loadManifest(env.paths), deps(env, fake), false), (error: CliError) =>
        error.code === 'UNINSTALL_CONFLICT' && error.detail!.includes(`${DSH_PACKAGE}: removed with DSH pnpm; `)
          && error.detail!.includes(label === 'not removable' ? `${link}: ms's link could not be removed` : `${link} is not ms's link to `), label);
      assert.deepEqual(await snapshotTree(dirname(link)), kept, label);
      assert.equal(await readFile(join(profile, 'package.json'), 'utf8'), PROFILE_PACKAGE, label);
      assert.deepEqual((await loadManifest(env.paths)).records.map(record => record.kind), ['dsh-bundle'], label);
      await stat(env.paths.root);
      await settle();
      await applyUninstall(await loadManifest(env.paths), deps(env, fake), false);
      assert.deepEqual(await snapshotTree(home), before, label);
    } finally { await cleanup(); }
  }
});

test('without the DSH app an untouched profile is still restored byte for byte from the backups', async () => {
  const { home, env, fake, cleanup } = await fixture();
  try {
    const before = await snapshotTree(home);
    await applyInstall(await planInstall(env), env);
    const gone = { ...fake.pnpm, ready: async () => false };
    const out = await applyUninstall(await loadManifest(env.paths), { ...deps(env, fake), dshPnpm: gone }, false);
    assert.match(out, /DSH app not found/);
    assert.deepEqual(fake.calls.map(call => call[0]), ['add']);
    assert.deepEqual(await snapshotTree(home), before);
  } finally { await cleanup(); }
});

test('after the plugin page installed another bundle, uninstall runs pnpm remove and takes only ours out of bundles', async () => {
  const { home, env, fake, profile, cleanup } = await fixture();
  try {
    await applyInstall(await planInstall(env), env);
    await otherBundle(home, profile, fake);
    await applyUninstall(await loadManifest(env.paths), deps(env, fake), false);
    assert.deepEqual(fake.calls.at(-1), ['remove', DSH_PACKAGE]);
    assert.deepEqual(fake.bundlesAt.at(-1), ['other-bundle', 'third-bundle'], 'bundles before pnpm remove');
    const manifest = await manifestOf(profile);
    assert.deepEqual(Object.keys(manifest.dependencies), ['other-bundle', 'third-bundle']);
    assert.deepEqual(manifest.dsh.profile.bundles, ['other-bundle', 'third-bundle']);
    await assert.rejects(readlink(join(profile, 'node_modules', DSH_PACKAGE)), { code: 'ENOENT' });
    assert.ok(await readlink(join(profile, 'node_modules', 'third-bundle')));
    await assert.rejects(stat(env.paths.root), { code: 'ENOENT' });
  } finally { await cleanup(); }
});

// An install killed before it recorded what pnpm wrote leaves no afterSha, so nothing proves the files untouched.
test('after an interrupted install a changed profile is removed with DSH pnpm keeping later changes; an unchanged one is a no-op', async () => {
  for (const label of ['changed', 'unchanged']) {
    const { home, env, fake, profile, cleanup } = await fixture();
    try {
      const before = await snapshotTree(home);
      await applyInstall(await planInstall(env), env);
      if (label === 'changed') await otherBundle(home, profile, fake);
      const record = await interruptLedger(env.paths.manifest, 'dsh-bundle');
      if (label === 'unchanged' && record.kind === 'dsh-bundle') {
        await restoreExact(record.packageJson);
        await restoreExact(record.pnpmLock);
        await rm(record.link);
      }
      const calls = fake.calls.length;
      const out = await applyUninstall(await loadManifest(env.paths), deps(env, fake), false);
      if (label === 'unchanged') {
        assert.match(out, /package\.json: unchanged by install/);
        assert.equal(fake.calls.length, calls);
        assert.deepEqual(await snapshotTree(home), before);
        continue;
      }
      assert.match(out, new RegExp(`${DSH_PACKAGE}: removed with DSH pnpm, later profile changes kept`));
      assert.deepEqual(fake.calls.slice(calls), [['remove', DSH_PACKAGE]]);
      const manifest = await manifestOf(profile);
      assert.deepEqual(Object.keys(manifest.dependencies), ['other-bundle', 'third-bundle']);
      assert.deepEqual(manifest.dsh.profile.bundles, ['other-bundle', 'third-bundle']);
    } finally { await cleanup(); }
  }
});

test('a bundle the plugin page already removed counts as reverted, with no pnpm call', async () => {
  const { env, fake, profile, cleanup } = await fixture();
  try {
    await applyInstall(await planInstall(env), env);
    const manifest = await manifestOf(profile);
    manifest.dsh.profile.bundles = ['other-bundle'];
    await writeFile(join(profile, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await fake.pnpm.run(profile, ['remove', DSH_PACKAGE]);
    const calls = fake.calls.length;
    const out = await applyUninstall(await loadManifest(env.paths), deps(env, fake), false);
    assert.match(out, /already removed/);
    assert.equal(fake.calls.length, calls);
  } finally { await cleanup(); }
});

test('the entry-switch override row DSH wrote is cleaned, in block and in flow form', async () => {
  const shapes = {
    block: { original: DESKTOP_PATCH, written: `${DESKTOP_PATCH}- id: ${ID}\n  disabled: true\n` },
    flow: { original: '[]\n', written: `[ { id: ${ID}, disabled: true } ]\n` },
  };
  for (const [label, shape] of Object.entries(shapes)) {
    const { home, env, fake, profile, cleanup } = await fixture();
    try {
      await writeFile(join(profile, 'cordis.patch.yml'), shape.original);
      const before = await snapshotTree(home);
      await applyInstall(await planInstall(env), env);
      await writeFile(join(profile, 'cordis.patch.yml'), shape.written);
      await applyUninstall(await loadManifest(env.paths), deps(env, fake), false);
      assert.deepEqual(await snapshotTree(home), before, label);
    } finally { await cleanup(); }
  }
});

test('any other row naming ms-dsh-client is a kept conflict; a rerun finishes once the user removes it', async () => {
  const { home, env, fake, profile, cleanup } = await fixture();
  try {
    const before = await snapshotTree(home);
    await applyInstall(await planInstall(env), env);
    const edited = `${DESKTOP_PATCH}- id: ${ID}\n  name: agent-message-switchboard-dsh\n  config: {}\n`;
    await writeFile(join(profile, 'cordis.patch.yml'), edited);
    await assert.rejects(applyUninstall(await loadManifest(env.paths), deps(env, fake), false), (error: CliError) =>
      error.code === 'UNINSTALL_CONFLICT' && /cordis\.patch\.yml: .*ms-dsh-client/.test(error.detail ?? ''));
    assert.equal(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'), edited);
    assert.deepEqual((await loadManifest(env.paths)).records.map(record => record.kind), ['dsh-bundle']);
    assert.equal(await readFile(join(profile, 'package.json'), 'utf8'), PROFILE_PACKAGE);
    await writeFile(join(profile, 'cordis.patch.yml'), DESKTOP_PATCH);
    await applyUninstall(await loadManifest(env.paths), deps(env, fake), false);
    assert.deepEqual(await snapshotTree(home), before);
  } finally { await cleanup(); }
});

test('an ms row split by a comment is a kept conflict: the patch stays as written and the private root is kept', async () => {
  const rows = {
    block: `${DESKTOP_PATCH}- id: ${ID}\n# note\n  disabled: true\n`,
    flow: `[ { id: other, disabled: true }, # ,\n  { id: ${ID}, disabled: true } ]\n`,
  };
  for (const [label, written] of Object.entries(rows)) {
    const { env, fake, profile, cleanup } = await fixture();
    try {
      await applyInstall(await planInstall(env), env);
      await writeFile(join(profile, 'cordis.patch.yml'), written);
      await assert.rejects(applyUninstall(await loadManifest(env.paths), deps(env, fake), false), (error: CliError) =>
        error.code === 'UNINSTALL_CONFLICT' && /cordis\.patch\.yml: .*ms-dsh-client/.test(error.detail ?? ''), label);
      assert.equal(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'), written, label);
      await stat(env.paths.root);
      assert.deepEqual((await loadManifest(env.paths)).records.map(record => record.kind), ['dsh-bundle'], label);
    } finally { await cleanup(); }
  }
});

test('a failing pnpm remove, or no DSH app to run it, is a kept conflict; a rerun finishes', async () => {
  for (const label of ['pnpm remove fails', 'DSH app missing']) {
    const { home, env, fake, profile, cleanup } = await fixture();
    try {
      await applyInstall(await planInstall(env), env);
      await otherBundle(home, profile, fake);
      const broken = label === 'DSH app missing' ? { ...fake.pnpm, ready: async () => false } : fake.pnpm;
      if (label === 'pnpm remove fails') fake.fail.add('remove');
      await assert.rejects(applyUninstall(await loadManifest(env.paths), { ...deps(env, fake), dshPnpm: broken }, false), (error: CliError) =>
        error.code === 'UNINSTALL_CONFLICT' && (label === 'DSH app missing' ? /plugin page/ : /remove exit 1/).test(error.detail ?? ''));
      assert.deepEqual((await loadManifest(env.paths)).records.map(record => record.kind), ['dsh-bundle'], label);
      fake.fail.clear();
      await applyUninstall(await loadManifest(env.paths), deps(env, fake), false);
      assert.equal((await manifestOf(profile)).dependencies[DSH_PACKAGE], undefined, label);
    } finally { await cleanup(); }
  }
});

test('a pnpm add that dies half way rolls the profile back byte for byte', async () => {
  const { home, env, fake, cleanup } = await fixture();
  try {
    fake.fail.add('add');
    const before = await snapshotTree(home);
    await assert.rejects(applyInstall(await planInstall(env), env), (error: CliError) =>
      error.code === 'INSTALL_FAILED' && /DSH_PNPM_FAILED: add exit 1/.test(error.detail ?? ''));
    assert.deepEqual(await snapshotTree(home), before);
  } finally { await cleanup(); }
});

test('a later failure in install also undoes the DSH bundle exactly', async () => {
  const failing: ClaudeStep = { lines: [], apply: async () => { throw new Error('boom'); } };
  const { home, env, fake, cleanup } = await fixture(failing);
  try {
    const before = await snapshotTree(home);
    await assert.rejects(applyInstall(await planInstall(env), env), { code: 'INSTALL_FAILED' });
    assert.deepEqual(fake.calls.map(call => call[0]), ['add', 'remove']);
    assert.deepEqual(await snapshotTree(home), before);
  } finally { await cleanup(); }
});

test('preconditions: an existing dependency, bundle entry, link, ms row, unreadable profile or missing DSH app skip only DSH, untouched', async () => {
  const cases: Record<string, (profile: string, env: ReturnType<typeof makeEnv>) => Promise<ReturnType<typeof makeEnv> | void>> = {
    dependency: async profile => writeFile(join(profile, 'package.json'), JSON.stringify({ dependencies: { [DSH_PACKAGE]: 'link:/x' } })),
    bundles: async profile => writeFile(join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: [DSH_PACKAGE] } } })),
    link: async profile => symlink('/x', join(profile, 'node_modules', DSH_PACKAGE)),
    'old path row': async profile => writeFile(join(profile, 'cordis.patch.yml'), `- insert:\n    - id: "${ID}"\n      name: "/old/index.mjs"\n`),
    'override row': async profile => writeFile(join(profile, 'cordis.patch.yml'), `[ { id: ${ID}, disabled: true } ]\n`),
    'no package.json': async profile => rm(join(profile, 'package.json')),
    'package.json not an object': async profile => writeFile(join(profile, 'package.json'), '[]\n'),
    'no DSH app': async (_profile, env) => ({ ...env, dshPnpm: { ...env.dshPnpm, ready: async () => false } }),
  };
  for (const [label, prepare] of Object.entries(cases)) {
    const { env, fake, profile, cleanup } = await fixture();
    try {
      const used = (await prepare(profile, env)) ?? env;
      const before = await snapshotTree(profile).catch(() => null);
      assert.match(describePlan(await planInstall(used), used.paths), /\n {2}dsh: skipped \(.+\); manual install: docs\/user-guide\.md#manual-dsh, plugin directory \//, label);
      assert.match(await applyInstall(await planInstall(used), used), /\ndsh: skipped \(/, label);
      assert.deepEqual(await snapshotTree(profile).catch(() => null), before, label);
      assert.deepEqual(fake.calls, [], label);
      assert.ok(!(await loadManifest(used.paths)).records.some(record => record.kind === 'dsh-bundle'), label);
    } finally { await cleanup(); }
  }
});

test('the real runner execs the DSH app as node with its bundled pnpm, the scrubbed environment and runtime/bin first on PATH', async () => {
  const app = await realpath(await mkdtemp('/tmp/ms-dsh-app-'));
  const cwd = await realpath(await mkdtemp('/tmp/ms-dsh-profile-'));
  try {
    const exec = join(app, 'Contents', 'MacOS', 'DeepSeek Harness');
    const pnpm = join(app, 'Contents', 'Resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs');
    const bin = join(app, 'Contents', 'Resources', 'runtime', 'bin');
    await mkdir(dirname(exec), { recursive: true });
    await mkdir(bin, { recursive: true });
    const record = join(app, 'record.txt');
    await writeFile(exec, `#!/bin/sh\n{ pwd; for a in "$@"; do echo "arg:$a"; done; env; } > '${record}'\n[ "$4" = "fail-me" ] && exit 3\nexit 0\n`);
    await chmod(exec, 0o755);
    const runner = systemDshPnpm(app, { PATH: '/usr/bin:/bin', OTHER: '1', MY_TOKEN: 'x', NPM_API_KEY: 'y', DSH_HOME: '/z' });
    assert.equal(await runner.ready(), false);
    await mkdir(dirname(pnpm), { recursive: true });
    await writeFile(pnpm, '// pnpm\n');
    assert.equal(await runner.ready(), true);
    await runner.run(cwd, ['add', 'link:/x', '--save-exact']);
    const lines = (await readFile(record, 'utf8')).split('\n');
    assert.equal(lines[0], cwd);
    assert.deepEqual(lines.filter(line => line.startsWith('arg:')), ['arg:--expose-internals', `arg:${pnpm}`, 'arg:add', 'arg:link:/x', 'arg:--save-exact']);
    for (const line of ['ELECTRON_RUN_AS_NODE=1', `DSH_DESKTOP_NODE_EXECUTABLE=${exec}`, `PATH=${bin}:/usr/bin:/bin`, 'OTHER=1']) {
      assert.ok(lines.includes(line), line);
    }
    for (const name of ['MY_TOKEN', 'NPM_API_KEY', 'DSH_HOME']) assert.ok(!lines.some(line => line.startsWith(`${name}=`)), name);
    await assert.rejects(runner.run(cwd, ['remove', 'fail-me']), { code: 'DSH_PNPM_FAILED', detail: 'remove exit 3' });
  } finally { await rm(app, { recursive: true, force: true }); await rm(cwd, { recursive: true, force: true }); }
});
