// INPUT: A private test directory and a scripted reply function per decoded control request.
// OUTPUT: startFakeDaemon → Unix-socket fake msd recording every request frame; close().
// POS: Test-only control-API double; never the real msd, host, model or user root.
import net from 'node:net';
import { once } from 'node:events';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createIpcDecoder, encodeIpcFrame } from '../../src/bridge/ipc-frame.ts';

export type FakeRequest = Readonly<{ schemaVersion: unknown; id: unknown; method: unknown; params: unknown }>;
export type FakeReply = ((request: FakeRequest) => unknown) | 'hang' | 'close' | Buffer;

export type FakeDaemon = Readonly<{
  socketPath: string;
  requests: FakeRequest[];
  close: () => Promise<void>;
}>;

export function okReply(result: unknown): (request: FakeRequest) => unknown {
  return request => ({ schemaVersion: 1, id: request.id, ok: true, result });
}

export function errorReply(error: string): (request: FakeRequest) => unknown {
  return request => ({ schemaVersion: 1, id: request.id, ok: false, error });
}

function answer(socket: net.Socket, reply: FakeReply, request: FakeRequest): void {
  if (reply === 'hang') return;
  if (reply === 'close') { socket.end(); return; }
  if (Buffer.isBuffer(reply)) { socket.end(reply); return; }
  socket.end(encodeIpcFrame(reply(request)));
}

export async function startFakeDaemon(reply: FakeReply): Promise<FakeDaemon> {
  const dir = await mkdtemp('/tmp/ms-cli-');
  await chmod(dir, 0o700);
  const socketPath = join(dir, 'msd.sock');
  const requests: FakeRequest[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const decoder = createIpcDecoder();
    socket.on('data', chunk => {
      for (const value of decoder.push(chunk)) {
        const request = value as FakeRequest;
        requests.push(request);
        answer(socket, reply, request);
      }
    });
    socket.on('error', () => undefined);
  });
  server.listen(socketPath);
  await once(server, 'listening');
  return Object.freeze({
    socketPath,
    requests,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.close();
      await rm(dir, { recursive: true, force: true });
    },
  });
}
