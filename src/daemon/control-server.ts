// INPUT: A private run-directory socket path and an async per-connection request dispatcher.
// OUTPUT: A 0600 Unix-socket listener with length-prefixed JSON requests, responses and server events.
// POS: msd control transport; same-UID filesystem trust only, no method semantics.
import net from 'node:net';
import { chmod, lstat, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createIpcDecoder } from '../bridge/ipc-frame.ts';
import { errorFrame, eventFrame, parseControlRequest, requestId, successFrame, type ControlRequest } from './control-protocol.ts';

export type ControlConnection = Readonly<{ emit: (event: string, data: unknown) => void; close: () => void;
  isOpen: () => boolean; whenClosed: Promise<void> }>;
export type Dispatch = (connection: ControlConnection, request: ControlRequest) => Promise<unknown>;

function connection(socket: net.Socket, dispatch: Dispatch): void {
  const decoder = createIpcDecoder();
  const closed = Promise.withResolvers<void>();
  let open = true;
  const write = (frame: Buffer) => { if (open) socket.write(frame); };
  const handle: ControlConnection = Object.freeze({
    emit: (event: string, data: unknown) => write(eventFrame(event, data)),
    close: () => { if (open) socket.destroy(); }, isOpen: () => open, whenClosed: closed.promise });
  const answer = async (value: unknown) => {
    let request: ControlRequest;
    try { request = parseControlRequest(value); }
    catch (error) { write(errorFrame(requestId(value), error)); if (requestId(value) === null) socket.end(); return; }
    try { write(successFrame(request.id, await dispatch(handle, request))); }
    catch (error) {
      try { write(errorFrame(request.id, error)); } catch { socket.destroy(); }
    }
  };
  socket.on('data', chunk => {
    let values: unknown[];
    try { values = decoder.push(chunk); } catch { socket.destroy(); return; }
    for (const value of values) void answer(value);
  });
  socket.on('end', () => socket.end());
  socket.on('error', () => {});
  socket.on('close', () => { open = false; closed.resolve(); });
}

async function clearStale(path: string): Promise<void> {
  const info = await lstat(path).catch(() => null);
  if (!info) return;
  if (!info.isSocket() || info.uid !== process.getuid!()) throw new Error('CONTROL_SOCKET_UNAVAILABLE');
  const live = await new Promise<boolean>(resolve => {
    const probe = net.createConnection(path);
    probe.once('connect', () => { probe.destroy(); resolve(true); });
    probe.once('error', () => resolve(false));
  });
  if (live) throw new Error('MSD_ALREADY_RUNNING');
  await rm(path);
}

export async function listenControl(path: string, dispatch: Dispatch) {
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || parent.uid !== process.getuid!() || (parent.mode & 0o077) !== 0) {
    throw new Error('CONTROL_SOCKET_UNAVAILABLE');
  }
  await clearStale(path);
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    connection(socket, dispatch);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => { server.off('error', reject); resolve(); });
  });
  await chmod(path, 0o600);
  return Object.freeze({ close: async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(path, { force: true });
  } });
}
