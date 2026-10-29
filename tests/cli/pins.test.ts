// INPUT: A scripted fake pin probe and temp executable stubs.
// OUTPUT: Python framework interpreter selection, the 3.13.14 floor, the Developer ID Python refusal (codesign probe), the
//         another-user's-Python refusal (the broker's owner rule) and the no-Claude-discovery rule (Claude is identified by code signature).
// POS: Offline pin-discovery tests; never hashes or runs the real Python/Claude binaries (darwin only asks codesign about /bin/ls).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { CliError, exitCodeFor } from '../../src/cli/errors.ts';
import { discoverPins, systemPinProbe, type PinProbe } from '../../src/cli/pins.ts';

const FRAMEWORK = '/opt/brew/Cellar/python@3.13/3.13.14_1/Frameworks/Python.framework/Versions/3.13';
const INTERPRETER = `${FRAMEWORK}/Resources/Python.app/Contents/MacOS/Python`;

function probe(overrides: Partial<PinProbe> = {}, files = new Set([INTERPRETER]), calls: string[] = []): PinProbe {
  const links: Record<string, string> = { '/opt/brew/bin/python3': `${FRAMEWORK}/bin/python3.13` };
  return {
    which: async name => { calls.push(`which ${name}`); return name === 'python3' ? '/opt/brew/bin/python3' : null; },
    realpath: async path => links[path] ?? path,
    isFile: async path => files.has(path),
    sha256: async path => { calls.push(`sha256 ${path}`); return createHash('sha256').update(path).digest('hex'); },
    pythonVersion: async () => '3.13.14',
    developerIdSigned: async () => false,
    ownedByUserOrRoot: async () => true,
    ...overrides,
  };
}

const DEVELOPER_ID_SHAPE = 'anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists'
  + ' and certificate leaf[field.1.2.840.113635.100.6.1.13] exists';
const hash = (path: string) => createHash('sha256').update(path).digest('hex');

test('pins only the framework Python.app interpreter; Claude binaries are neither looked up nor hashed', async () => {
  const calls: string[] = [];
  assert.deepEqual(await discoverPins(probe({}, new Set([INTERPRETER]), calls)), {
    python: { path: INTERPRETER, sha256: hash(INTERPRETER) }, claude: { wrapperPins: [] } });
  assert.deepEqual(calls, ['which python3', `sha256 ${INTERPRETER}`]);
});

test('missing or unsuitable Python is INSTALL_PRECONDITION_FAILED; a missing claude on PATH is not', async () => {
  const cases: Array<Partial<PinProbe> | Set<string>> = [
    { which: async () => null },
    { pythonVersion: async () => '3.12.9' },
    { pythonVersion: async () => '3.13.13' },
    { pythonVersion: async () => 'garbage' },
    new Set<string>(),
  ];
  for (const item of cases) {
    const fake = item instanceof Set ? probe({}, item) : probe(item);
    await assert.rejects(discoverPins(fake), { code: 'INSTALL_PRECONDITION_FAILED' });
  }
  assert.equal((await discoverPins(probe())).python.path, INTERPRETER);
});

test('system probe resolves PATH executables, symlinks, hashes and python version output', async () => {
  const dir = await mkdtemp('/tmp/ms-pins-');
  try {
    await mkdir(join(dir, 'bin'));
    await writeFile(join(dir, 'real-python'), '#!/bin/sh\necho 3.13.14\n');
    await chmod(join(dir, 'real-python'), 0o755);
    await writeFile(join(dir, 'bin', 'plain'), 'x');
    await symlink(join(dir, 'real-python'), join(dir, 'bin', 'python3'));
    const system = systemPinProbe(`relative:${join(dir, 'bin')}`);
    assert.equal(await system.which('python3'), join(dir, 'bin', 'python3'));
    assert.equal(await system.which('plain'), null);
    assert.equal(await system.which('absent'), null);
    assert.ok((await system.realpath(join(dir, 'bin', 'python3'))).endsWith('/real-python'));
    assert.equal(await system.sha256(join(dir, 'bin', 'plain')), hash('x'));
    assert.equal(await system.pythonVersion(join(dir, 'real-python')), '3.13.14');
    await assert.rejects(system.pythonVersion(join(dir, 'bin', 'plain')), { code: 'INSTALL_PRECONDITION_FAILED' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Python is accepted from 3.13.14 upward with no upper bound, and the actual framework interpreter stays pinned', async () => {
  for (const version of ['3.13.14', '3.13.15', '3.14.0', '3.20.1']) {
    const pins = await discoverPins(probe({ pythonVersion: async () => version }));
    assert.equal(pins.python.path, INTERPRETER, version);
  }
});

test('a Developer ID signed interpreter (python.org) is refused with UNSUPPORTED_PYTHON_SIGNATURE before it is hashed', async () => {
  const calls: string[] = [];
  const checked: string[] = [];
  const signed = probe({ developerIdSigned: async path => { checked.push(path); return true; } }, new Set([INTERPRETER]), calls);
  await assert.rejects(discoverPins(signed), (error: CliError) =>
    error.code === 'UNSUPPORTED_PYTHON_SIGNATURE' && exitCodeFor(error.code) === 5 && /Homebrew/.test(error.detail ?? ''));
  assert.deepEqual(checked, [INTERPRETER]);
  assert.deepEqual(calls, ['which python3']);
});

test('a Python owned by another user (another account\'s Homebrew) is refused with UNSUPPORTED_PYTHON_OWNER before it is hashed', async () => {
  const calls: string[] = [];
  const checked: string[] = [];
  const foreign = probe({ ownedByUserOrRoot: async path => { checked.push(path); return false; } }, new Set([INTERPRETER]), calls);
  await assert.rejects(discoverPins(foreign), (error: CliError) =>
    error.code === 'UNSUPPORTED_PYTHON_OWNER' && exitCodeFor(error.code) === 5 && error.detail?.startsWith(INTERPRETER) === true
      && /you or root/.test(error.detail ?? ''));
  assert.deepEqual(checked, [INTERPRETER]);
  assert.deepEqual(calls, ['which python3']);
});

test('system probe applies the broker\'s owner rule: own files pass, writable-by-others files or directories and symlinks do not', async () => {
  const dir = await realpath(await mkdtemp('/tmp/ms-owner-'));
  try {
    const system = systemPinProbe('');
    const python = join(dir, 'python');
    await writeFile(python, 'x'); await chmod(python, 0o755);
    assert.equal(await system.ownedByUserOrRoot(python), true);
    await chmod(python, 0o775);
    assert.equal(await system.ownedByUserOrRoot(python), false, 'group-writable interpreter');
    await chmod(python, 0o755); await chmod(dir, 0o777);
    assert.equal(await system.ownedByUserOrRoot(python), false, 'world-writable directory without the sticky bit');
    await chmod(dir, 0o700); await symlink(python, join(dir, 'link'));
    assert.equal(await system.ownedByUserOrRoot(join(dir, 'link')), false, 'a symlink is not the interpreter itself');
    assert.equal(await system.ownedByUserOrRoot(join(dir, 'absent')), false);
  } finally { await chmod(dir, 0o700); await rm(dir, { recursive: true, force: true }); }
});

test('real root-owned system binaries pass the owner rule', { skip: process.platform !== 'darwin' }, async () => {
  assert.equal(await systemPinProbe('').ownedByUserOrRoot('/bin/ls'), true);
});

async function fakeCodesign(dir: string, exit: number): Promise<string> {
  const path = join(dir, `codesign-${exit}`);
  await writeFile(path, `#!/bin/sh\nprintf '%s\\n' "$@" > "$0.args"\nexit ${exit}\n`);
  await chmod(path, 0o755);
  return path;
}

test('system probe asks codesign for the broker Developer ID shape: 0 signed, 1/3 not, anything else fails closed', async () => {
  const dir = await mkdtemp('/tmp/ms-codesign-');
  try {
    const verdicts: Array<[number, boolean]> = [[0, true], [1, false], [3, false]];
    for (const [exit, expected] of verdicts) {
      const codesign = await fakeCodesign(dir, exit);
      assert.equal(await systemPinProbe('', codesign).developerIdSigned(INTERPRETER), expected, `exit ${exit}`);
      assert.deepEqual((await readFile(`${codesign}.args`, 'utf8')).split('\n').slice(0, -1),
        ['--verify', '-R', `=${DEVELOPER_ID_SHAPE}`, '--', INTERPRETER]);
    }
    for (const codesign of [await fakeCodesign(dir, 2), join(dir, 'absent')]) {
      await assert.rejects(systemPinProbe('', codesign).developerIdSigned(INTERPRETER), { code: 'INSTALL_PRECONDITION_FAILED' });
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the install-time requirement is the one the broker checks before it reports a signer', async () => {
  const native = await readFile(new URL('../../src/bridge/native/macos_identity.py', import.meta.url), 'utf8');
  const joined = native.replace(/'\s*\n\s*f?'/g, '');
  assert.ok(joined.includes(`'${DEVELOPER_ID_SHAPE} and certificate leaf[subject.OU]`));
});

test('real codesign reports an Apple platform binary as not Developer ID signed', { skip: process.platform !== 'darwin' }, async () => {
  assert.equal(await systemPinProbe('').developerIdSigned('/bin/ls'), false);
});
