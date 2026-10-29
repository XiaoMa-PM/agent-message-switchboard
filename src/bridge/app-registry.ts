// INPUT: Fixed config root, kernel-authenticated CLI PID, original SID and canonical socket.
// OUTPUT: Synchronous registry consistency check or one sanitized unavailable error.
// POS: Same-UID host metadata corroboration; never process or session authentication.
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { isAbsolute, join } from 'node:path';

export type AppRegistryOptions = Readonly<{ configRoot: string; cliPid: number;
  nativeSessionId: string; socketPath: string }>;

function canonical(path: string): void {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')
    || fs.realpathSync(path) !== path) throw new Error('INVALID_PATH');
}

function safeNode(path: string, directory: boolean): fs.Stats {
  const info = fs.lstatSync(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())
    || info.uid !== process.getuid!() || (info.mode & 0o022) !== 0) throw new Error('INVALID_NODE');
  return info;
}

function same(before: fs.Stats, after: fs.Stats): void {
  for (const key of ['dev', 'ino', 'uid', 'gid', 'mode', 'size', 'mtimeMs', 'ctimeMs'] as const) {
    if (before[key] !== after[key]) throw new Error('REGISTRY_CHANGED');
  }
}

function checkEntry(value: unknown, options: AppRegistryOptions): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_ENTRY');
  const raw = value as Record<string, unknown>;
  if (raw.pid !== options.cliPid || raw.sessionId !== options.nativeSessionId
    || typeof raw.procStart !== 'string' || !raw.procStart
    || typeof raw.messagingSocketPath !== 'string' || !isAbsolute(raw.messagingSocketPath)
    || raw.messagingSocketPath.includes('\0')
    || fs.realpathSync(raw.messagingSocketPath) !== options.socketPath) throw new Error('INVALID_ENTRY');
  const observed = childProcess.execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(options.cliPid)],
    { encoding: 'utf8', env: { LC_ALL: 'C', TZ: 'UTC', PATH: '/usr/bin:/bin' } }).trim();
  if (!observed || observed !== raw.procStart) throw new Error('PROCESS_START_MISMATCH');
}

export function verifyAppRegistry(options: AppRegistryOptions): void {
  let fd: number | undefined;
  try {
    if (!Number.isSafeInteger(options.cliPid) || options.cliPid <= 1
      || typeof options.nativeSessionId !== 'string' || !options.nativeSessionId.trim()) throw new Error('INVALID_OPTIONS');
    canonical(options.configRoot); canonical(options.socketPath);
    const sessions = join(options.configRoot, 'sessions'); canonical(sessions);
    const parent = safeNode(sessions, true);
    const path = join(sessions, String(options.cliPid) + '.json');
    const before = safeNode(path, false);
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    same(before, fs.fstatSync(fd));
    const raw: unknown = JSON.parse(fs.readFileSync(fd, 'utf8'));
    checkEntry(raw, options);
    same(before, fs.fstatSync(fd)); same(before, safeNode(path, false));
    same(parent, safeNode(sessions, true)); canonical(sessions);
  } catch { throw new Error('APP_REGISTRY_UNAVAILABLE'); }
  finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { throw new Error('APP_REGISTRY_UNAVAILABLE'); }
    }
  }
}
