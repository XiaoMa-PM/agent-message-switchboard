// INPUT: The msd control socket path and an event callback.
// OUTPUT: A correlated request/response channel over 4-byte length-prefixed JSON frames, plus server events.
// POS: Client side of the shared msd control API; same-UID private socket only, no identity or routing logic.
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createIpcDecoder, encodeIpcFrame } from '../../bridge/ipc-frame.ts';

export type MsdEvent = Readonly<{ event: string; data: unknown }>;
export type MsdChannel = Readonly<{ request: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  close: () => void; closed: Promise<void> }>;
type Pending = Readonly<{ resolve: (value: unknown) => void; reject: (error: Error) => void }>;

const CODE = /^[A-Z][A-Z0-9_]+$/;

export function msdSocketPath(root: string): string {
  return join(root, 'run', 'msd.sock');
}

async function privateSocket(path: string): Promise<void> {
  const uid = process.getuid!();
  try {
    const [socket, directory] = await Promise.all([lstat(path), lstat(dirname(path))]);
    if (socket.isSocket() && socket.uid === uid && directory.isDirectory() && directory.uid === uid
        && (directory.mode & 0o077) === 0) return;
  } catch { /* Missing socket or directory: msd is not running. */ }
  throw new Error('MS_UNAVAILABLE');
}

function settle(frame: Record<string, unknown>, waiter: Pending): void {
  if (frame.ok === true) { waiter.resolve(frame.result); return; }
  waiter.reject(new Error(typeof frame.error === 'string' && CODE.test(frame.error) ? frame.error : 'INTERNAL_ERROR'));
}

export async function openMsdChannel(path: string, onEvent: (event: MsdEvent) => void): Promise<MsdChannel> {
  await privateSocket(path);
  const socket = net.createConnection(path);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', () => reject(new Error('MS_UNAVAILABLE')));
  });
  const decoder = createIpcDecoder();
  const closed = Promise.withResolvers<void>();
  let pending = new Map<string, Pending>();
  socket.on('error', () => {});
  socket.on('close', () => {
    for (const waiter of pending.values()) waiter.reject(new Error('MS_UNAVAILABLE'));
    pending = new Map();
    closed.resolve();
  });
  socket.on('data', chunk => {
    let frames: unknown[];
    try { frames = decoder.push(chunk); } catch { socket.destroy(); return; }
    for (const raw of frames) {
      const frame = raw as Record<string, unknown>;
      if (frame.schemaVersion !== 1) continue;
      if (typeof frame.event === 'string') { onEvent(Object.freeze({ event: frame.event, data: frame.data })); continue; }
      const waiter = typeof frame.id === 'string' ? pending.get(frame.id) : undefined;
      if (!waiter) continue;
      pending = new Map([...pending].filter(([id]) => id !== frame.id));
      settle(frame, waiter);
    }
  });
  const request = (method: string, params: Record<string, unknown>) => {
    if (socket.destroyed) return Promise.reject(new Error('MS_UNAVAILABLE'));
    const id = randomUUID();
    const deferred = Promise.withResolvers<unknown>();
    let frame: Buffer;
    try { frame = encodeIpcFrame({ schemaVersion: 1, id, method, params }); }
    catch (error) {
      return Promise.reject(new Error((error as Error).message === 'IPC_FRAME_TOO_LARGE' ? 'BODY_TOO_LARGE' : 'INVALID_REQUEST'));
    }
    pending = new Map([...pending, [id, { resolve: deferred.resolve, reject: deferred.reject }]]);
    socket.write(frame);
    return deferred.promise;
  };
  return Object.freeze({ request, closed: closed.promise, close: () => socket.destroy() });
}
