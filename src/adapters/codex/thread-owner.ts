// INPUT: Codex home, host-supplied thread UUID, read-only lsof/ps output.
// OUTPUT: Writer-lock path, holder pids, owner checks, owner-parent surface facts and exec-server parent detection.
// POS: Kernel-observed Codex thread ownership; never opens, takes or removes a writer lock.
import { execFile } from 'node:child_process';
import { basename, isAbsolute, join } from 'node:path';

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export type HolderLister = (path: string) => Promise<readonly number[]>;
export type ProcessFacts = Readonly<{ parentPid: number; executable: string }>;
export type ClientSurface = 'cli' | 'desktop';

export function parseThreadId(value: unknown): string {
  if (typeof value !== 'string' || !THREAD_ID.test(value)) throw new Error('INVALID_THREAD_ID');
  return value;
}

export function writerLockPath(codexHome: string, threadId: string): string {
  if (typeof codexHome !== 'string' || !isAbsolute(codexHome)) throw new Error('INVALID_CODEX_HOME');
  return join(codexHome, 'thread-writer-locks', `${parseThreadId(threadId)}.lock`);
}

function pid(text: string, minimum: number): number {
  const value = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error('OWNER_PROBE_FAILED');
  return value;
}

export function parseLsofPids(stdout: string): readonly number[] {
  const pids = stdout.split('\n').filter(line => line.startsWith('p')).map(line => pid(line.slice(1), 2));
  return Object.freeze([...new Set(pids)]);
}

function run(file: string, args: readonly string[]): Promise<{ code: number; stdout: string }> {
  return new Promise(resolve => {
    execFile(file, args, { encoding: 'utf8' }, (error, stdout) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout });
    });
  });
}

// lsof exits 1 with no output when no process has the file open (including a missing lock file).
export const lsofHolders: HolderLister = async path => {
  const { code, stdout } = await run('/usr/sbin/lsof', ['-n', '-P', '-F', 'p', '--', path]);
  if (code !== 0 && !(code === 1 && stdout.trim() === '')) throw new Error('OWNER_PROBE_FAILED');
  return parseLsofPids(stdout);
};

export async function holdsWriterLock(list: HolderLister, codexHome: string, threadId: string, ownerPid: number): Promise<boolean> {
  return (await list(writerLockPath(codexHome, threadId))).includes(ownerPid);
}

export function parsePsFacts(stdout: string): ProcessFacts {
  const match = /^\s*(\d+) (\S.*?)\s*$/.exec(stdout);
  if (!match) throw new Error('OWNER_PROBE_FAILED');
  return Object.freeze({ parentPid: pid(match[1], 0), executable: match[2] });
}

export async function psProcessFacts(target: number): Promise<ProcessFacts> {
  const { code, stdout } = await run('/bin/ps', ['-o', 'ppid=,comm=', '-p', String(target)]);
  if (code !== 0) throw new Error('OWNER_PROBE_FAILED');
  return parsePsFacts(stdout);
}

export async function psCommandLine(target: number): Promise<string> {
  const { code, stdout } = await run('/bin/ps', ['-o', 'args=', '-p', String(target)]);
  if (code !== 0) throw new Error('OWNER_PROBE_FAILED');
  return stdout.trim();
}

// ChatGPT Local Work drives the agent from the cloud and starts MCP servers via `codex [-c <kv>]... exec-server`.
export function isRemoteExecutor(executable: string, commandLine: string): boolean {
  if (basename(executable) !== 'codex' || !commandLine.startsWith(`${executable} `)) return false;
  const words = commandLine.slice(executable.length + 1).split(/\s+/);
  let index = 0;
  while (words[index] === '-c' || words[index] === '--config') index += 2;
  return words[index] === 'exec-server';
}

// The desktop app-server is a child of the app main executable; CLI/daemon owners are not.
export function surfaceOf(ownerParentExecutable: string): ClientSurface {
  return /\.app\/Contents\/MacOS\/[^/]+$/.test(ownerParentExecutable) && basename(ownerParentExecutable) !== 'codex'
    ? 'desktop' : 'cli';
}
