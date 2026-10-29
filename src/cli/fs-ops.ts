// INPUT: Absolute paths and bytes for user-owned or ms-owned files.
// OUTPUT: readOptional, sha256 helpers, appendedBytes, atomic same-directory replace, private mkdir and exclusive lock files.
// POS: Low-level filesystem primitives for install/uninstall; refuses to follow a symlinked target file.
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { CliError } from './errors.ts';

export type FileState = Readonly<{ bytes: Buffer; mode: number }> | null;

export function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function readOptional(path: string): Promise<FileState> {
  let info;
  try { info = await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!info.isFile()) throw new CliError('INSTALL_PRECONDITION_FAILED', `not a regular file: ${basename(path)}`);
  return Object.freeze({ bytes: await readFile(path), mode: info.mode & 0o777 });
}

export function appendedBytes(original: FileState, text: string): string | null {
  if (original === null) return null;
  const before = original.bytes.toString('utf8');
  return text.length > before.length && text.startsWith(before) ? text.slice(before.length) : null;
}

export async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch { return false; }
}

export async function replaceFile(path: string, bytes: Buffer | string, mode: number): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.ms-${process.pid}-${Date.now()}`);
  await writeFile(temporary, bytes, { mode, flag: 'wx' });
  try { await rename(temporary, path); } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function makePrivateDir(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700 });
}

export async function withLockFile<T>(lockPath: string, run: () => Promise<T>): Promise<T> {
  let handle;
  try { handle = await open(lockPath, 'wx', 0o600); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new CliError('INSTALL_PRECONDITION_FAILED', 'dsh profile is locked');
    throw error;
  }
  try {
    await handle.writeFile(String(process.pid));
    await handle.close();
    return await run();
  } finally {
    await rm(lockPath, { force: true });
  }
}
