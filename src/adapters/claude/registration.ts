// INPUT: SessionStart session ID, exported socket and trusted process inspection.
// OUTPUT: Private atomic routes; live fixed-version targets rejected on shared owner or socket.
// POS: Claude target registration only; no token, transcript, model or discovery.
import { randomUUID, createHash } from 'node:crypto';
import { basename, join, isAbsolute } from 'node:path';
import { lstat, open, writeFile, link, rm, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { parseEndpoint, type Endpoint } from '../../protocol/message.ts';

export type Owner = Readonly<{ pid: number; parent: number; command: string; start: string }>;
export type Inspect = (pid: number) => Owner | null;
export type ClaudeRoute = Readonly<{ schemaVersion: 1; endpoint: Endpoint; socket: string; ownerPid: number; ownerStart: string }>;

function sessionId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) throw new Error('INVALID_SESSION');
  return value;
}

async function privateDirectory(root: string): Promise<void> {
  if (!isAbsolute(root)) throw new Error('INVALID_DIRECTORY');
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0) throw new Error('INVALID_DIRECTORY');
}

function cliOwner(pid: number, inspect: Inspect): Owner {
  let seen = new Set<number>();
  while (Number.isSafeInteger(pid) && pid > 1 && !seen.has(pid)) {
    seen = new Set([...seen, pid]);
    const owner = inspect(pid);
    if (!owner || owner.pid !== pid || !owner.start) break;
    if (basename(owner.command) === '2.1.295') return Object.freeze({ ...owner });
    pid = owner.parent;
  }
  throw new Error('INVALID_OWNER');
}

async function socketAvailable(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error('INVALID_SOCKET');
  const stat = await lstat(path);
  if (!stat.isSocket() || stat.uid !== process.getuid!()) throw new Error('INVALID_SOCKET');
}

export async function registerClaude(root: string, payload: unknown, socket: string, parentPid: number, inspect: Inspect): Promise<ClaudeRoute> {
  const sid = sessionId((payload as Record<string, unknown> | null)?.session_id);
  const owner = cliOwner(parentPid, inspect);
  await privateDirectory(root); await socketAvailable(socket);
  const endpoint = parseEndpoint({ schemaVersion: 1, endpointId: `claude:${sid}`, harness: 'claude-code',
    storageNamespace: createHash('sha256').update(root).digest('hex'), nativeSessionId: sid,
    hostInstanceId: `claude-pid:${owner.pid}`, routeGeneration: randomUUID() });
  const route = Object.freeze({ schemaVersion: 1 as const, endpoint, socket, ownerPid: owner.pid, ownerStart: owner.start });
  const temporary = join(root, `${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(route), { mode: 0o600, flag: 'wx' });
    await link(temporary, join(root, sid + '.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('DUPLICATE_SESSION');
    throw error;
  } finally { await rm(temporary, { force: true }); }
  return route;
}

async function savedRoute(root: string, sid: string): Promise<ClaudeRoute> {
  const file = await open(join(root, sid + '.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  let raw: Record<string, unknown>;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0) throw new Error('INVALID_ROUTE');
    raw = JSON.parse(await file.readFile('utf8'));
  } finally { await file.close(); }
  if (!raw || typeof raw !== 'object' || Object.keys(raw).length !== 5 || raw.schemaVersion !== 1
      || !Number.isSafeInteger(raw.ownerPid) || Number(raw.ownerPid) < 2 || (typeof raw.ownerStart !== 'string' || !raw.ownerStart.trim())
      || typeof raw.socket !== 'string') throw new Error('INVALID_ROUTE');
  const endpoint = parseEndpoint(raw.endpoint);
  if (endpoint.harness !== 'claude-code' || endpoint.nativeSessionId !== sid || endpoint.endpointId !== `claude:${sid}`
      || endpoint.hostInstanceId !== `claude-pid:${raw.ownerPid}`
      || endpoint.storageNamespace !== createHash('sha256').update(root).digest('hex')) throw new Error('INVALID_ROUTE');
  return Object.freeze({ schemaVersion: 1, endpoint, socket: raw.socket, ownerPid: Number(raw.ownerPid), ownerStart: raw.ownerStart });
}

export async function readClaude(root: string, requestedSid: string, inspect: Inspect): Promise<ClaudeRoute> {
  const sid = sessionId(requestedSid);
  await privateDirectory(root);
  const route = await savedRoute(root, sid);
  for (const name of await readdir(root)) {
    if (!name.endsWith('.json') || name === sid + '.json') continue;
    const other = await savedRoute(root, sessionId(name.slice(0, -5)));
    if (other.socket === route.socket || (other.ownerPid === route.ownerPid && other.ownerStart === route.ownerStart)) {
      throw new Error('TARGET_UNAVAILABLE');
    }
  }
  const owner = inspect(route.ownerPid);
  if (!owner || owner.pid !== route.ownerPid || owner.start !== route.ownerStart || basename(owner.command) !== '2.1.295') throw new Error('TARGET_UNAVAILABLE');
  await socketAvailable(route.socket);
  return route;
}
