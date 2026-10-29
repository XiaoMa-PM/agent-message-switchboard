// INPUT: Exclusive private temporary directories and locally owned Unix sockets.
// OUTPUT: Socket capture/freeze and replacement/permission rejection assertions.
// POS: Offline App socket filesystem sampling tests; no App or SID proof.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { captureAppSocket, verifyAppSocket } from '../../src/bridge/app-socket.ts';

async function listen(path: string): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  chmodSync(path, 0o600);
  return server;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

const unavailable = { message: 'APP_SOCKET_UNAVAILABLE' };

test('captures a frozen canonical socket and rejects invalid paths and node types', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ms-app-socket-'));
  chmodSync(root, 0o700);
  const socket = join(root, 'app.sock');
  const server = await listen(socket);
  try {
    const pin = captureAppSocket(socket);
    assert.equal(pin.path, realpathSync(socket));
    assert.equal(Object.isFrozen(pin), true);
    assert.equal(Object.isFrozen(pin.parent), true);
    verifyAppSocket(pin);
    for (const path of ['relative', `${socket}\0`, root, join(root, 'missing')]) {
      assert.throws(() => captureAppSocket(path), unavailable);
    }
    const file = join(root, 'file');
    writeFileSync(file, 'fixture');
    assert.throws(() => captureAppSocket(file), unavailable);
    const alias = join(root, 'alias.sock');
    symlinkSync(socket, alias);
    assert.throws(() => captureAppSocket(alias), unavailable);
    const parentAlias = `${root}-alias`;
    symlinkSync(root, parentAlias);
    try {
      assert.throws(() => captureAppSocket(join(parentAlias, 'app.sock')), unavailable);
    } finally {
      unlinkSync(parentAlias);
    }
  } finally {
    await close(server);
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects socket and parent permission changes and vanished socket', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ms-app-socket-'));
  chmodSync(root, 0o700);
  const socket = join(root, 'app.sock');
  const server = await listen(socket);
  try {
    const pin = captureAppSocket(socket);
    chmodSync(socket, 0o660);
    assert.throws(() => verifyAppSocket(pin), unavailable);
    chmodSync(socket, 0o755);
    verifyAppSocket(captureAppSocket(socket));
    assert.throws(() => verifyAppSocket(pin), unavailable);
    chmodSync(socket, 0o600);
    chmodSync(root, 0o750);
    assert.throws(() => captureAppSocket(socket), unavailable);
    assert.throws(() => verifyAppSocket(pin), unavailable);
    chmodSync(root, 0o700);
    unlinkSync(socket);
    assert.throws(() => verifyAppSocket(pin), unavailable);
  } finally {
    await close(server);
    rmSync(root, { recursive: true, force: true });
  }
});

test('unlink and rebind cannot reuse a captured inode', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ms-app-socket-'));
  chmodSync(root, 0o700);
  const socket = join(root, 'app.sock');
  const first = await listen(socket);
  let second: Server | undefined;
  try {
    const pin = captureAppSocket(socket);
    unlinkSync(socket);
    second = await listen(socket);
    assert.throws(() => verifyAppSocket(pin), unavailable);
  } finally {
    await close(first);
    if (second) await close(second);
    rmSync(root, { recursive: true, force: true });
  }
});

test('replaced parent or socket path cannot preserve a captured pin', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ms-app-socket-'));
  chmodSync(root, 0o700);
  const moved = `${root}-moved`;
  const socket = join(root, 'app.sock');
  const first = await listen(socket);
  let second: Server | undefined;
  try {
    const pin = captureAppSocket(socket);
    renameSync(root, moved);
    mkdirSync(root, { mode: 0o700 });
    second = await listen(socket);
    assert.throws(() => verifyAppSocket(pin), unavailable);
    await close(second);
    second = undefined;
    writeFileSync(socket, 'replacement');
    assert.throws(() => verifyAppSocket(pin), unavailable);
    unlinkSync(socket);
    symlinkSync(join(moved, 'app.sock'), socket);
    assert.throws(() => verifyAppSocket(pin), unavailable);
  } finally {
    await close(first);
    if (second) await close(second);
    rmSync(root, { recursive: true, force: true });
    rmSync(moved, { recursive: true, force: true });
  }
});
