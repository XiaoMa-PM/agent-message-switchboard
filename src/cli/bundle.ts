// INPUT: A source root (checkout or installed package), relative include paths and its npm-shrinkwrap.json text (lockfile v3 shape).
// OUTPUT: runtimePackageDirs (dependencies+peers closure), listSourceFiles, pinSources and copyBundle (verified read-only copy + bundle.json).
// POS: Builds the immutable runtime bundle so installed ms/msd never execute from a mutable worktree.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CliError } from './errors.ts';

export type SourceFile = Readonly<{ relative: string; source: string; executable: boolean }>;
export type PinnedFile = Readonly<{ path: string; sha256: string; mode: number; size: number }>;
export type PinnedBundle = Readonly<{ digest: string; files: readonly PinnedFile[] }>;

const SKIPPED_NAMES = new Set(['__pycache__', '.DS_Store', 'node_modules']);

function precondition(detail: string): never {
  throw new CliError('INSTALL_PRECONDITION_FAILED', detail);
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch { return false; }
}

type LockEntry = Readonly<{
  optional?: boolean;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}>;

function resolveInLock(packages: Readonly<Record<string, LockEntry>>, from: string, name: string): string | null {
  let base = from;
  for (;;) {
    const key = `${base ? `${base}/` : ''}node_modules/${name}`;
    if (Object.hasOwn(packages, key)) return key;
    if (!base) return null;
    const cut = base.lastIndexOf('/node_modules/');
    base = cut < 0 ? '' : base.slice(0, cut);
  }
}

function edges(entry: LockEntry): Array<{ name: string; optional: boolean }> {
  const meta = entry.peerDependenciesMeta ?? {};
  return [
    ...Object.keys(entry.dependencies ?? {}).map(name => ({ name, optional: false })),
    ...Object.keys(entry.peerDependencies ?? {}).map(name => ({ name, optional: meta[name]?.optional === true })),
    ...Object.keys(entry.optionalDependencies ?? {}).map(name => ({ name, optional: true })),
  ];
}

export async function runtimePackageDirs(sourceRoot: string, lockText: string): Promise<string[]> {
  const packages = (JSON.parse(lockText) as { packages?: Record<string, LockEntry> }).packages;
  if (packages === undefined || !Object.hasOwn(packages, '')) precondition('npm-shrinkwrap has no root package');
  const selected = new Set<string>();
  const queue = [''];
  while (queue.length) {
    const from = queue.shift()!;
    for (const edge of edges(packages[from])) {
      const key = resolveInLock(packages, from, edge.name);
      if (key === null) { if (edge.optional) continue; precondition(`unresolved package: ${edge.name}`); }
      if (selected.has(key)) continue;
      if (!(await exists(join(sourceRoot, key)))) {
        if (edge.optional || packages[key].optional === true) continue;
        precondition(`required package missing: ${key}`);
      }
      selected.add(key);
      queue.push(key);
    }
  }
  return [...selected].sort();
}

async function walk(sourceRoot: string, relative: string, found: SourceFile[]): Promise<void> {
  const source = join(sourceRoot, relative);
  const info = await lstat(source);
  if (info.isSymbolicLink()) precondition(`symlink in bundle source: ${relative}`);
  if (info.isFile()) {
    if (!relative.endsWith('.pyc')) found.push(Object.freeze({ relative, source, executable: (info.mode & 0o100) !== 0 }));
    return;
  }
  if (!info.isDirectory()) precondition(`unsupported file type: ${relative}`);
  for (const name of (await readdir(source)).sort()) {
    if (!SKIPPED_NAMES.has(name)) await walk(sourceRoot, `${relative}/${name}`, found);
  }
}

export async function listSourceFiles(sourceRoot: string, includes: readonly string[]): Promise<SourceFile[]> {
  const found: SourceFile[] = [];
  for (const include of includes) {
    if (!(await exists(join(sourceRoot, include)))) precondition(`bundle include missing: ${include}`);
    await walk(sourceRoot, include, found);
  }
  return found.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function digestOf(files: readonly PinnedFile[]): string {
  return createHash('sha256')
    .update(files.map(file => `${file.path}\0${file.mode.toString(8)}\0${file.sha256}`).join('\n'))
    .digest('hex');
}

export async function pinSources(files: readonly SourceFile[]): Promise<PinnedBundle> {
  const pinned: PinnedFile[] = [];
  for (const file of files) {
    const size = (await lstat(file.source)).size;
    pinned.push(Object.freeze({ path: file.relative, sha256: await sha256File(file.source), mode: file.executable ? 0o500 : 0o400, size }));
  }
  return Object.freeze({ digest: digestOf(pinned), files: Object.freeze(pinned) });
}

async function copyOne(file: SourceFile, pin: PinnedFile, target: string): Promise<void> {
  const destination = join(target, file.relative);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await copyFile(file.source, destination);
  await chmod(destination, pin.mode);
  if (await sha256File(destination) !== pin.sha256) throw new CliError('INSTALL_FAILED', `source changed: ${file.relative}`);
}

export async function copyBundle(files: readonly SourceFile[], target: string, expected: PinnedBundle): Promise<void> {
  if (files.length !== expected.files.length || files.some((file, index) => file.relative !== expected.files[index].path)) {
    throw new CliError('INSTALL_FAILED', 'bundle file list changed');
  }
  if (await exists(target)) precondition('bundle target already exists');
  await mkdir(target, { recursive: true, mode: 0o700 });
  for (const [index, file] of files.entries()) await copyOne(file, expected.files[index], target);
  const record = { schemaVersion: 1, digest: expected.digest, files: expected.files };
  await writeFile(join(target, 'bundle.json'), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o400, flag: 'wx' });
}
