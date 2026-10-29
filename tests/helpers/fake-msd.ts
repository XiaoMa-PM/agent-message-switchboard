// INPUT: A private temp directory (or a given root, to come up late or again at the same socket path) and per-method synthetic answers.
// OUTPUT: A length-prefixed control socket that records requests, can emit adapter events, drop connections and count open ones.
// POS: Offline stand-in for the msd adapter channel; no routing or identity logic.
import net from 'node:net';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { createIpcDecoder, encodeIpcFrame } from '../../src/bridge/ipc-frame.ts';

export type Answer = (params: Record<string, any>) => unknown;
export type FakeMsd = Readonly<{ root: string; socketPath: string; requests: Array<{ method: string; params: Record<string, any> }>;
  answers: Map<string, Answer>; emit: (event: string, data: unknown) => void; dropConnections: () => void; connections: () => number;
  waitFor: (method: string, count?: number) => Promise<Record<string, any>>; close: () => Promise<void> }>;

const DEFAULTS: Record<string, Answer> = {
  'adapter.attach': () => ({ attached: true, harness: 'codex', autoRegister: false }),
  register: params => ({ harness: 'codex', sessionId: params.sessionId, registered: params.mode !== 'auto', project: null }),
  unregister: () => ({ unregistered: true }),
  list: () => [],
  send: params => ({ sent: true, receipt: { messageId: params.messageId ?? 'generated', state: 'dispatched', transport: null,
    sequence: 1, linkId: 'link-1', targetHarness: params.harness, targetSessionId: params.target } }),
  reply: params => ({ sent: true, receipt: { messageId: params.messageId ?? 'generated', state: 'delivery-unknown',
    transport: 'written', sequence: 2, linkId: 'link-1', targetHarness: 'claude-code', targetSessionId: 'c' } }),
  'deliver.result': () => ({}),
};

export async function startFakeMsd(at?: string): Promise<FakeMsd> {
  const root = at ?? await mkdtemp('/tmp/ms-fake-');
  await mkdir(join(root, 'run'), { recursive: true, mode: 0o700 });
  await chmod(join(root, 'run'), 0o700);
  const socketPath = join(root, 'run', 'msd.sock');
  const requests: Array<{ method: string; params: Record<string, any> }> = [];
  const answers = new Map<string, Answer>(Object.entries(DEFAULTS));
  const sockets = new Set<net.Socket>();
  const waiters: Array<() => void> = [];
  const server = net.createServer(socket => {
    sockets.add(socket);
    const decoder = createIpcDecoder();
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.on('data', chunk => {
      for (const frame of decoder.push(chunk) as Array<Record<string, any>>) {
        requests.push({ method: frame.method, params: frame.params });
        waiters.splice(0).forEach(wake => wake());
        const answer = answers.get(frame.method);
        try {
          if (!answer) throw new Error('UNKNOWN_METHOD');
          socket.write(encodeIpcFrame({ schemaVersion: 1, id: frame.id, ok: true, result: answer(frame.params) }));
        } catch (error) {
          socket.write(encodeIpcFrame({ schemaVersion: 1, id: frame.id, ok: false, error: (error as Error).message }));
        }
      }
    });
  });
  server.listen(socketPath);
  await once(server, 'listening');
  await chmod(socketPath, 0o600);
  const waitFor = async (method: string, count = 1) => {
    for (;;) {
      const matches = requests.filter(request => request.method === method);
      if (matches.length >= count) return matches[count - 1].params;
      await new Promise<void>(resolve => waiters.push(resolve));
    }
  };
  return { root, socketPath, requests, answers, waitFor,
    emit: (event, data) => { for (const socket of sockets) socket.write(encodeIpcFrame({ schemaVersion: 1, event, data })); },
    dropConnections: () => { for (const socket of sockets) socket.destroy(); },
    connections: () => sockets.size,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    } };
}
