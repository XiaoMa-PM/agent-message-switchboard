// INPUT: Synthetic source trees, npm-shrinkwrap (lockfile v3) fixtures and private temp directories.
// OUTPUT: Production-closure selection, copy/pin hashing, read-only modes and symlink refusal regressions.
// POS: Offline bundle tests; never copies the real repository or user root.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, stat, readFile, rm, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { listSourceFiles, runtimePackageDirs, pinSources, copyBundle } from '../../src/cli/bundle.ts';

const LOCK = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    '': { name: 'x', dependencies: { prod: '1' }, peerDependencies: { host: '1' }, devDependencies: { devonly: '1' } },
    'node_modules/prod': { dependencies: { nested: '1', shared: '1' }, optionalDependencies: { 'other-platform': '1' } },
    'node_modules/prod/node_modules/nested': { peerDependencies: { absentpeer: '1' }, peerDependenciesMeta: { absentpeer: { optional: true } } },
    'node_modules/shared': {},
    'node_modules/host': { dependencies: { 'required-missing': '1' } },
    'node_modules/devonly': { dev: true },
    'node_modules/other-platform': { optional: true },
    'node_modules/required-missing': {},
  },
});

async function tree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ms-bundle-'));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return root;
}

test('runtime closure follows dependencies and peers, nearest nested copy first, skipping dev and absent optional', async () => {
  const root = await tree({
    'node_modules/prod/index.js': '', 'node_modules/prod/node_modules/nested/i.js': '', 'node_modules/shared/i.js': '',
    'node_modules/host/i.js': '', 'node_modules/devonly/i.js': '',
  });
  try {
    await assert.rejects(runtimePackageDirs(root, LOCK), { code: 'INSTALL_PRECONDITION_FAILED' });
    await mkdir(join(root, 'node_modules/required-missing'));
    assert.deepEqual(await runtimePackageDirs(root, LOCK), [
      'node_modules/host', 'node_modules/prod', 'node_modules/prod/node_modules/nested', 'node_modules/required-missing', 'node_modules/shared',
    ]);
    const unresolved = JSON.stringify({ packages: { '': { dependencies: { ghost: '1' } } } });
    await assert.rejects(runtimePackageDirs(root, unresolved), { code: 'INSTALL_PRECONDITION_FAILED' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('source listing walks includes, skips bytecode caches and nested node_modules, keeps exec bits', async () => {
  const root = await tree({
    'package.json': '{}', 'src/a.ts': 'a', 'src/native/b.py': 'b', 'src/native/__pycache__/b.cpython.pyc': 'x', 'src/.DS_Store': 'x',
    'node_modules/prod/index.js': 'p', 'node_modules/prod/node_modules/nested/i.js': 'n', 'node_modules/prod/bin/tool': 't',
  });
  try {
    await chmod(join(root, 'node_modules/prod/bin/tool'), 0o755);
    const files = await listSourceFiles(root, ['package.json', 'src', 'node_modules/prod']);
    assert.deepEqual(files.map(file => [file.relative, file.executable]), [
      ['node_modules/prod/bin/tool', true], ['node_modules/prod/index.js', false],
      ['package.json', false], ['src/a.ts', false], ['src/native/b.py', false],
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('symlinks and missing includes are refused', async () => {
  const root = await tree({ 'src/a.ts': 'a' });
  try {
    await symlink(join(root, 'src/a.ts'), join(root, 'src/link.ts'));
    await assert.rejects(listSourceFiles(root, ['src']), { code: 'INSTALL_PRECONDITION_FAILED' });
    await assert.rejects(listSourceFiles(root, ['absent']), { code: 'INSTALL_PRECONDITION_FAILED' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('pins hash sources, copy verifies them into read-only private modes with bundle.json', async () => {
  const root = await tree({ 'package.json': '{"type":"module"}', 'src/a.ts': 'export {}' });
  const dest = await mkdtemp(join(tmpdir(), 'ms-bundle-dest-'));
  try {
    await chmod(join(root, 'src/a.ts'), 0o775);
    const files = await listSourceFiles(root, ['package.json', 'src']);
    const pinned = await pinSources(files);
    assert.deepEqual(pinned.files, [
      { path: 'package.json', sha256: createHash('sha256').update('{"type":"module"}').digest('hex'), mode: 0o400, size: 17 },
      { path: 'src/a.ts', sha256: createHash('sha256').update('export {}').digest('hex'), mode: 0o500, size: 9 },
    ]);
    assert.match(pinned.digest, /^[0-9a-f]{64}$/);
    const target = join(dest, 'b');
    await copyBundle(files, target, pinned);
    assert.equal((await stat(join(target, 'src/a.ts'))).mode & 0o777, 0o500);
    assert.equal((await stat(join(target, 'src'))).mode & 0o777, 0o700);
    assert.equal(await readFile(join(target, 'src/a.ts'), 'utf8'), 'export {}');
    assert.deepEqual(JSON.parse(await readFile(join(target, 'bundle.json'), 'utf8')), { schemaVersion: 1, ...pinned });
    assert.equal((await pinSources(files)).digest, pinned.digest);
    await assert.rejects(copyBundle(files, target, pinned), { code: 'INSTALL_PRECONDITION_FAILED' });
    await writeFile(join(root, 'src/a.ts'), 'changed');
    await assert.rejects(copyBundle(files, join(dest, 'c'), pinned), { code: 'INSTALL_FAILED' });
    await assert.rejects(copyBundle(files.slice(1), join(dest, 'd'), pinned), { code: 'INSTALL_FAILED' });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(dest, { recursive: true, force: true });
  }
});
