// INPUT: Caller-trusted fixed file pins, private paths and an owned launcher/verifier.
// OUTPUT: A verified owned child, or fixed failure after owned-resource cleanup; trustedInterpreter (the interpreter owner rule).
// POS: Filesystem/spawn boundary; path pins retain TOCTOU and do not attest a running image.
import { type BinaryPin } from '../adapters/claude/peer-identity.ts';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync,
  realpathSync, type BigIntStats } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';

export type HelperConfig = Readonly<{ python: BinaryPin; codeRoot: string; entryPath: string;
  configPath: string; codePins: readonly BinaryPin[] }>;
type SpawnOptions = Readonly<{ env: Readonly<Record<string, string>>;
  stdio: readonly ['pipe', 'pipe', 'pipe']; shell: false }>;
export type OwnedLauncher<Child extends object> = Readonly<{
  spawn: (path: string, args: readonly string[], options: SpawnOptions) => Child;
  verifyStarted: (child: Child) => Promise<void>;
  closeOwned: (child: Child) => Promise<void> }>;
type Witness = Readonly<{ path: string; stat: BigIntStats; full: boolean }>;
const identityKeys = ['dev', 'ino', 'mode', 'uid', 'gid'] as const;
const fileKeys = [...identityKeys, 'size', 'mtimeNs', 'ctimeNs'] as const;

function fail(): never { throw new Error('HELPER_START_FAILED'); }

function pin(value: BinaryPin): BinaryPin {
  if (!value || Object.keys(value).length !== 2 || typeof value.path !== 'string' || !isAbsolute(value.path)
      || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) fail();
  return Object.freeze({ path: value.path, sha256: value.sha256 });
}

function configuration(value: HelperConfig): HelperConfig {
  if (!value || Object.keys(value).length !== 5 || !Array.isArray(value.codePins) || value.codePins.length === 0
      || [value.codeRoot, value.entryPath, value.configPath].some(path => typeof path !== 'string' || !isAbsolute(path))) fail();
  const codePins = value.codePins.map(pin);
  if (new Set(codePins.map(value => value.path)).size !== codePins.length) fail();
  return Object.freeze({ python: pin(value.python), codeRoot: value.codeRoot,
    entryPath: value.entryPath, configPath: value.configPath, codePins: Object.freeze(codePins) });
}

function canonical(path: string): BigIntStats {
  if (!isAbsolute(path) || realpathSync(path) !== path) fail();
  const stat = lstatSync(path, { bigint: true });
  if (stat.isSymbolicLink()) fail();
  return stat;
}

function same(before: BigIntStats, after: BigIntStats, full: boolean): void {
  if (!(full ? fileKeys : identityKeys).every(key => before[key] === after[key])) fail();
}

function ancestors(path: string, uid: bigint): readonly Witness[] {
  const found: Witness[] = [];
  let directory = dirname(path);
  while (true) {
    const stat = canonical(directory);
    if (!stat.isDirectory() || (stat.uid !== uid && stat.uid !== 0n)
        || ((stat.mode & 0o020n) !== 0n && stat.gid !== 0n && stat.gid !== 80n)
        || ((stat.mode & 0o002n) !== 0n && (stat.mode & 0o1000n) === 0n)) fail();
    found.push(Object.freeze({ path: directory, stat, full: false }));
    const parent = dirname(directory);
    if (parent === directory) return Object.freeze(found);
    directory = parent;
  }
}

function inside(root: string, path: string): boolean {
  const value = relative(root, path);
  return value !== '' && value !== '..' && !value.startsWith('../') && !isAbsolute(value);
}

function regular(path: string, uid: bigint, executable: boolean): BigIntStats {
  const stat = canonical(path);
  if (!stat.isFile() || (stat.uid !== uid && (!executable || stat.uid !== 0n)) || (stat.mode & 0o022n) !== 0n) fail();
  return stat;
}

// The owner rule preflight applies to the pinned interpreter, for install and repin to check before they pin one.
export function trustedInterpreter(path: string, uid: bigint): boolean {
  try { ancestors(path, uid); regular(path, uid, true); return true; } catch { return false; }
}

function recheck(witnesses: readonly Witness[]): void {
  for (const witness of witnesses) same(witness.stat, canonical(witness.path), witness.full);
}

function hashFile(expected: BinaryPin, uid: bigint, executable: boolean): Witness {
  const before = regular(expected.path, uid, executable);
  const fd = openSync(expected.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    same(before, fstatSync(fd, { bigint: true }), true);
    const digest = createHash('sha256'); const buffer = Buffer.alloc(65536);
    let count: number;
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) !== 0) digest.update(buffer.subarray(0, count));
    same(before, fstatSync(fd, { bigint: true }), true);
    same(before, regular(expected.path, uid, executable), true);
    if (digest.digest('hex') !== expected.sha256) fail();
    return Object.freeze({ path: expected.path, stat: before, full: true });
  } finally { closeSync(fd); }
}

function privateTree(config: HelperConfig, uid: bigint): readonly Witness[] {
  if (!inside(config.codeRoot, config.entryPath) || !inside(config.codeRoot, config.configPath)) fail();
  const root = canonical(config.codeRoot);
  if (!root.isDirectory() || root.uid !== uid || (root.mode & 0o777n) !== 0o700n) fail();
  const pins = new Map(config.codePins.map(pin => [pin.path, pin]));
  if (!pins.has(config.entryPath) || pins.has(config.configPath)
      || config.codePins.some(pin => !inside(config.codeRoot, pin.path))) fail();
  const pending = [config.codeRoot]; const seen = new Set<string>(); const witnesses: Witness[] = [];
  let foundConfig = false;
  while (pending.length) {
    const path = pending.pop()!; const stat = canonical(path);
    if (stat.isDirectory()) {
      if (stat.uid !== uid || (stat.mode & 0o077n) !== 0n) fail();
      witnesses.push(Object.freeze({ path, stat, full: true }));
      for (const name of readdirSync(path)) pending.push(join(path, name));
    } else if (path === config.configPath) {
      if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o777n) !== 0o600n) fail();
      foundConfig = true; witnesses.push(Object.freeze({ path, stat, full: true }));
    } else {
      const expected = pins.get(path);
      if (!expected) fail();
      witnesses.push(hashFile(expected, uid, false)); seen.add(path);
    }
  }
  if (!foundConfig || seen.size !== pins.size) fail();
  return Object.freeze(witnesses);
}

function preflight(config: HelperConfig): void {
  if (typeof process.getuid !== 'function') fail();
  const uid = BigInt(process.getuid());
  const chain = ancestors(config.python.path, uid);
  const tree = privateTree(config, uid);
  const codeChain = ancestors(config.entryPath, uid);
  recheck(tree); recheck(chain); recheck(codeChain);
  hashFile(config.python, uid, true);
  recheck(chain); recheck(codeChain);
}

function launcher<Child extends object>(value: OwnedLauncher<Child>): OwnedLauncher<Child> {
  if (!value || [value.spawn, value.verifyStarted, value.closeOwned].some(fn => typeof fn !== 'function')) fail();
  return Object.freeze({ spawn: value.spawn.bind(value), verifyStarted: value.verifyStarted.bind(value),
    closeOwned: value.closeOwned.bind(value) });
}

// The trusted verifier must check kernel identity/path/parent, not a claimed PID or a disk digest alone.
// A launcher allocating resources then throwing before returning its handle owns that cleanup itself.
export async function startOwnedHelper<Child extends object>(input: HelperConfig,
  spawnAdapter: OwnedLauncher<Child>): Promise<Child> {
  let child: Child | undefined; let owned: OwnedLauncher<Child> | undefined;
  try {
    const config = configuration(input); owned = launcher(spawnAdapter);
    const args = Object.freeze(['-I', '-S', config.entryPath, config.configPath]);
    const options: SpawnOptions = Object.freeze({ env: Object.freeze({}),
      stdio: Object.freeze(['pipe', 'pipe', 'pipe'] as const), shell: false });
    preflight(config);
    const created = owned.spawn(config.python.path, args, options);
    if (!created || typeof created !== 'object') fail();
    child = created;
    const verification = owned.verifyStarted(child);
    if (!(verification instanceof Promise)) fail();
    const proof: unknown = await verification;
    if (proof !== undefined) fail();
    return child;
  } catch {
    if (child && owned) {
      try {
        const cleanup = owned.closeOwned(child);
        if (!(cleanup instanceof Promise)) throw new Error('HELPER_CLEANUP_FAILED');
        await cleanup;
      } catch { throw new Error('HELPER_CLEANUP_FAILED'); }
    }
    throw new Error('HELPER_START_FAILED');
  }
}
