// INPUT: Private temporary synthetic files, fixed pins and an injected owned launcher.
// OUTPUT: Filesystem admission, exact isolated spawn and verified-start cleanup regressions.
// POS: Offline helper-start tests; no executable, child process, model or foreign PID is run.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { chmod, chown, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { startOwnedHelper, type HelperConfig, type OwnedLauncher } from '../../src/bridge/helper-process.ts';

type Child = { label: string; closed: boolean };
const hash = (content: string) => createHash('sha256').update(content).digest('hex');

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ms-helper-start-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const runtime = join(root, 'runtime'); const codeRoot = join(root, 'code'); const nested = join(codeRoot, 'lib');
  for (const path of [runtime, codeRoot, nested]) await mkdir(path, { mode: 0o700 });
  const python = join(runtime, 'python'); const entryPath = join(codeRoot, 'entry.py'); const module = join(nested, 'module.py');
  const configPath = join(codeRoot, 'config.json');
  await writeFile(python, 'synthetic executable; never run', { mode: 0o700 });
  await writeFile(entryPath, 'sys.dont_write_bytecode = True\nsynthetic entry', { mode: 0o600 });
  await writeFile(module, 'synthetic pinned module', { mode: 0o600 });
  await writeFile(configPath, 'not JSON: contents must never be parsed', { mode: 0o600 });
  const config: HelperConfig = { python: { path: python, sha256: hash('synthetic executable; never run') },
    codeRoot, entryPath, configPath, codePins: [{ path: entryPath, sha256: hash('sys.dont_write_bytecode = True\nsynthetic entry') },
      { path: module, sha256: hash('synthetic pinned module') }] };
  const child: Child = { label: 'owned synthetic handle', closed: false };
  const calls: Array<{ kind: string; value?: unknown }> = [];
  const launcher: OwnedLauncher<Child> = {
    spawn(path, args, options) { calls.push({ kind: 'spawn', value: { path, args, options } }); return child; },
    async verifyStarted(value) { assert.equal(value, child); calls.push({ kind: 'verify' }); },
    async closeOwned(value) { assert.equal(value, child); value.closed = true; calls.push({ kind: 'cleanup' }); },
  };
  return { root, runtime, nested, module, config, child, calls, launcher };
}

test('successful start validates all pins and returns only the verified owned child', async t => {
  const f = await fixture(t);
  const result = await startOwnedHelper(f.config, f.launcher);
  assert.equal(result, f.child); assert.equal(result.closed, false);
  assert.deepEqual(f.calls, [{ kind: 'spawn', value: { path: f.config.python.path,
    args: ['-I', '-S', f.config.entryPath, f.config.configPath],
    options: { env: {}, stdio: ['pipe', 'pipe', 'pipe'], shell: false } } }, { kind: 'verify' }]);
});

test('raw path characters stay literal argv and no fallback interpreter is tried', async t => {
  const f = await fixture(t); const path = join(f.config.codeRoot, 'entry $HOME $(touch marker) `echo text` ".py');
  await writeFile(path, 'literal-name code', { mode: 0o600 });
  const config = { ...f.config, entryPath: path, codePins: [...f.config.codePins, { path, sha256: hash('literal-name code') }] };
  await startOwnedHelper(config, f.launcher);
  assert.equal(f.calls.filter(call => call.kind === 'spawn').length, 1);
  assert.deepEqual((f.calls[0].value as { args: unknown }).args, ['-I', '-S', path, f.config.configPath]);
});

test('interpreter digest changes reject before spawn instead of accepting the current digest', async t => {
  const f = await fixture(t); await writeFile(f.config.python.path, 'changed interpreter', { mode: 0o700 });
  await assert.rejects(startOwnedHelper(f.config, f.launcher), /^Error: HELPER_START_FAILED$/);
  assert.equal(f.calls.length, 0);
});

test('code digest, missing pin, extra unpinned file and duplicate pins fail before spawn', async t => {
  const f = await fixture(t);
  for (const config of [{ ...f.config, codePins: f.config.codePins.slice(0, 1) },
    { ...f.config, codePins: [...f.config.codePins, f.config.codePins[0]] },
    { ...f.config, codePins: [...f.config.codePins, { path: join(f.config.codeRoot, 'missing.py'), sha256: 'a'.repeat(64) }] },
    { ...f.config, codePins: [{ ...f.config.codePins[0], sha256: '0'.repeat(64) }, f.config.codePins[1]] }]) {
    await assert.rejects(startOwnedHelper(config, f.launcher), /^Error: HELPER_START_FAILED$/);
  }
  await writeFile(join(f.config.codeRoot, 'unexpected.pyc'), 'untracked bytecode', { mode: 0o600 });
  await assert.rejects(startOwnedHelper(f.config, f.launcher), /^Error: HELPER_START_FAILED$/);
  assert.equal(f.calls.length, 0);
});

test('canonical interpreter entry config and code-root paths cannot be symlinks or relative', async t => {
  const f = await fixture(t); const linkedPython = join(f.root, 'linked-python');
  const linkedRoot = join(f.root, 'linked-code'); const linkedEntry = join(f.config.codeRoot, 'linked-entry.py');
  await symlink(f.config.python.path, linkedPython); await symlink(f.config.codeRoot, linkedRoot);
  for (const config of [{ ...f.config, python: { ...f.config.python, path: linkedPython } },
    { ...f.config, codeRoot: linkedRoot }, { ...f.config, entryPath: 'entry.py' },
    { ...f.config, configPath: join(f.root, 'outside.json') }]) {
    await assert.rejects(startOwnedHelper(config, f.launcher), /^Error: HELPER_START_FAILED$/);
  }
  await symlink(f.config.entryPath, linkedEntry);
  await assert.rejects(startOwnedHelper(f.config, f.launcher), /^Error: HELPER_START_FAILED$/);
  assert.equal(f.calls.length, 0);
});

test('config alone is unpinned and is never read as code or parsed as JSON', async t => {
  const f = await fixture(t);
  await startOwnedHelper(f.config, f.launcher);
  assert.equal(await readFile(f.config.configPath, 'utf8'), 'not JSON: contents must never be parsed');
  f.calls.length = 0;
  await assert.rejects(startOwnedHelper({ ...f.config, codePins: [...f.config.codePins,
    { path: f.config.configPath, sha256: 'a'.repeat(64) }] }, f.launcher), /^Error: HELPER_START_FAILED$/);
  assert.equal(f.calls.length, 0);
});

test('private root and internal directories reject group or other access', async t => {
  const f = await fixture(t);
  for (const [path, mode] of [[f.config.codeRoot, 0o750], [f.nested, 0o755]] as const) {
    await chmod(path, mode);
    await assert.rejects(startOwnedHelper(f.config, f.launcher), /^Error: HELPER_START_FAILED$/);
    await chmod(path, 0o700);
  }
  assert.equal(f.calls.length, 0);
});

test('interpreter code and config file permissions fail closed', async t => {
  const f = await fixture(t);
  for (const [path, mode, restore] of [[f.config.python.path, 0o722, 0o700],
    [f.module, 0o622, 0o600], [f.config.configPath, 0o640, 0o600]] as const) {
    await chmod(path, mode);
    await assert.rejects(startOwnedHelper(f.config, f.launcher), /^Error: HELPER_START_FAILED$/);
    await chmod(path, restore);
  }
  assert.equal(f.calls.length, 0);
});

test('executable ancestors reject unknown writable groups and nonsticky world write', async t => {
  const f = await fixture(t);
  const group = process.getgroups!().find(value => value !== 0 && value !== 80);
  if (group === undefined && process.getuid!() !== 0) { t.skip('no writable nonprivileged fixture group'); return; }
  await chown(f.runtime, process.getuid!(), group ?? 20);
  await chmod(f.runtime, 0o770);
  await assert.rejects(startOwnedHelper(f.config, f.launcher), /^Error: HELPER_START_FAILED$/);
  await chmod(f.runtime, 0o707);
  await assert.rejects(startOwnedHelper(f.config, f.launcher), /^Error: HELPER_START_FAILED$/);
  assert.equal(f.calls.length, 0);
});

test('known admin group write and sticky other-write ancestors are admitted', async t => {
  const f = await fixture(t);
  await chmod(f.runtime, 0o1707); await startOwnedHelper(f.config, f.launcher);
  if (process.getgroups!().includes(80)) {
    f.calls.length = 0; await chown(f.runtime, process.getuid!(), 80); await chmod(f.runtime, 0o770);
    await startOwnedHelper(f.config, f.launcher); assert.equal(f.calls[0].kind, 'spawn');
  }
});

test('a required genuine Promise verifier gates success and owns cleanup on rejection', async t => {
  const f = await fixture(t); const entered = Promise.withResolvers<void>(); const gate = Promise.withResolvers<void>();
  const launcher = { ...f.launcher, async verifyStarted(child: Child) {
    assert.equal(child, f.child); entered.resolve(); await gate.promise;
  } };
  let returned = false; const started = startOwnedHelper(f.config, launcher).then(child => { returned = true; return child; });
  await entered.promise; assert.equal(returned, false); gate.reject(new Error('raw private kernel detail'));
  await assert.rejects(started, /^Error: HELPER_START_FAILED$/);
  assert.equal(f.child.closed, true); assert.equal(f.calls.filter(call => call.kind === 'cleanup').length, 1);
  assert.equal(f.calls.filter(call => call.kind === 'spawn').length, 1);
});

test('cleanup failure has a separate fixed code and never returns the live child', async t => {
  const f = await fixture(t); let cleanups = 0;
  const launcher = { ...f.launcher, async verifyStarted() { throw new Error('private verifier failure'); },
    async closeOwned(child: Child) { assert.equal(child, f.child); cleanups += 1; throw new Error('private cleanup failure'); } };
  await assert.rejects(startOwnedHelper(f.config, launcher), /^Error: HELPER_CLEANUP_FAILED$/);
  assert.equal(cleanups, 1); assert.equal(f.child.closed, false); assert.equal(f.calls.length, 1);
});

test('missing or synchronous verifier and cleanup adapters never pretend successful verification', async t => {
  const f = await fixture(t);
  for (const field of ['verifyStarted', 'closeOwned', 'spawn']) {
    await assert.rejects(startOwnedHelper(f.config, { ...f.launcher, [field]: undefined } as unknown as OwnedLauncher<Child>),
      /^Error: HELPER_START_FAILED$/);
  }
  assert.equal(f.calls.length, 0);
  await assert.rejects(startOwnedHelper(f.config, { ...f.launcher, verifyStarted: () => ({ pid: 1 }) } as unknown as OwnedLauncher<Child>),
    /^Error: HELPER_START_FAILED$/);
  assert.equal(f.child.closed, true);
});

test('a Promise resolving bare PID or digest claims is not the void verifier contract', async t => {
  const f = await fixture(t);
  for (const claim of [50, { pid: 50 }, 'a'.repeat(64), true]) {
    await assert.rejects(startOwnedHelper(f.config, { ...f.launcher,
      verifyStarted: async () => claim } as unknown as OwnedLauncher<Child>), /^Error: HELPER_START_FAILED$/);
  }
  assert.equal(f.calls.filter(call => call.kind === 'cleanup').length, 4);
});

test('malformed pins, unpinned entry and nonfile interpreter fail before launch', async t => {
  const f = await fixture(t);
  for (const config of [{ ...f.config, python: { ...f.config.python, sha256: 'not-fixed' } },
    { ...f.config, entryPath: f.config.configPath }, { ...f.config, python: { ...f.config.python, path: f.runtime } },
    { ...f.config, codePins: [] }, { ...f.config, codePins: [{ path: f.root, sha256: 'a'.repeat(64) }] }]) {
    await assert.rejects(startOwnedHelper(config, f.launcher), /^Error: HELPER_START_FAILED$/);
  }
  assert.equal(f.calls.length, 0);
});

test('spawn failure never retries or guesses a PID to kill', async t => {
  const f = await fixture(t); let spawns = 0; let cleanups = 0;
  const launcher = { ...f.launcher, spawn() { spawns += 1; throw new Error('private spawn error'); },
    async closeOwned() { cleanups += 1; } };
  await assert.rejects(startOwnedHelper(f.config, launcher), /^Error: HELPER_START_FAILED$/);
  assert.equal(spawns, 1); assert.equal(cleanups, 0);
});

test('launcher methods retain their original owned-resource context', async t => {
  const f = await fixture(t);
  const owner = { owned: new Set<Child>(),
    spawn() { this.owned.add(f.child); return f.child; },
    async verifyStarted(child: Child) { assert.equal(this.owned.has(child), true); },
    async closeOwned(child: Child) { this.owned.delete(child); child.closed = true; } };
  assert.equal(await startOwnedHelper(f.config, owner), f.child);
  assert.equal(owner.owned.has(f.child), true);
});

async function separateCodeParent(f: Awaited<ReturnType<typeof fixture>>) {
  const parent = join(f.root, 'code-parent'); await mkdir(parent, { mode: 0o700 });
  const codeRoot = join(parent, 'code'); await rename(f.config.codeRoot, codeRoot);
  const move = (path: string) => join(codeRoot, relative(f.config.codeRoot, path));
  const config = { ...f.config, codeRoot, entryPath: move(f.config.entryPath), configPath: move(f.config.configPath),
    codePins: f.config.codePins.map(pin => ({ ...pin, path: move(pin.path) })) };
  return { parent, config };
}

test('code-root outer ancestors obey the same nonsticky and writable-group policy', async t => {
  const f = await fixture(t); const { parent, config } = await separateCodeParent(f);
  await chmod(parent, 0o777);
  await assert.rejects(startOwnedHelper(config, f.launcher), /^Error: HELPER_START_FAILED$/);
  const group = process.getgroups!().find(value => value !== 0 && value !== 80);
  if (group !== undefined || process.getuid!() === 0) {
    await chown(parent, process.getuid!(), group ?? 20); await chmod(parent, 0o775);
    await assert.rejects(startOwnedHelper(config, f.launcher), /^Error: HELPER_START_FAILED$/);
  }
  assert.equal(f.calls.length, 0);
});

test('code-root outer sticky and admin ancestors remain separate from private inner permissions', async t => {
  const f = await fixture(t); const { parent, config } = await separateCodeParent(f);
  await chmod(parent, 0o1707); await startOwnedHelper(config, f.launcher);
  if (process.getgroups!().includes(80)) {
    await chown(parent, process.getuid!(), 80); await chmod(parent, 0o1777);
    await startOwnedHelper(config, f.launcher);
  }
  await chmod(config.codeRoot, 0o750);
  await assert.rejects(startOwnedHelper(config, f.launcher), /^Error: HELPER_START_FAILED$/);
});

test('foreign-owner ancestor is rejected in a real temporary tree when ownership can be assigned', async t => {
  if (process.getuid!() !== 0) { t.skip('foreign chown needs root; no escalation for a fixture'); return; }
  const f = await fixture(t); const { parent, config } = await separateCodeParent(f);
  await chown(parent, 12345, 0);
  try { await assert.rejects(startOwnedHelper(config, f.launcher), /^Error: HELPER_START_FAILED$/); }
  finally { await chown(parent, process.getuid!(), process.getgid!()); }
  assert.equal(f.calls.length, 0);
});
