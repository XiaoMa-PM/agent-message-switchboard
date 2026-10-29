// INPUT: Synthetic msd roots of chosen byte lengths (ASCII and multi-byte user names), the install planner and startMsd.
// OUTPUT: The Unix socket path length guard: both sockets msd and its broker bind are measured in UTF-8
//         bytes against macOS's 103; ms install (dry run included) and msd startup refuse a longer one with MS_SOCKET_PATH_TOO_LONG.
// POS: Offline guard tests; nothing binds a socket, nothing under the synthetic homes is created.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { CliError, exitCodeFor } from '../../src/cli/errors.ts';
import { planInstall } from '../../src/cli/install.ts';
import { resolvePaths } from '../../src/cli/paths.ts';
import { startMsd } from '../../src/daemon/msd.ts';
import { longSocketPath, MAX_SOCKET_PATH_BYTES, runPaths } from '../../src/daemon/paths.ts';
import { makeEnv, makeSource } from '../cli/install-fixture.ts';

// A home whose broker socket is exactly `bytes` long, padded with `unit` (one ASCII or one multi-byte character per step).
function homeFor(bytes: number, unit = 'u'): string {
  const base = '/Users/';
  const fixed = Buffer.byteLength(runPaths(resolvePaths(`${base}x`).root).brokerSocket) - Buffer.byteLength(`${base}x`);
  const room = bytes - fixed - Buffer.byteLength(base);
  const size = Buffer.byteLength(unit);
  assert.equal(room % size, 0, 'pick a length the unit divides');
  return base + unit.repeat(room / size);
}

test('the guard measures both sockets in UTF-8 bytes: 103 bytes pass, 104 do not, whichever socket is longer', () => {
  assert.equal(MAX_SOCKET_PATH_BYTES, 103);
  const fits = resolvePaths(homeFor(103)).root;
  assert.equal(longSocketPath(fits), null);
  const over = resolvePaths(homeFor(104)).root;
  assert.deepEqual(longSocketPath(over), { path: runPaths(over).brokerSocket, bytes: 104 });
  const wide = resolvePaths(homeFor(105, '黄')).root;
  assert.equal(wide.length < 103, true, 'short in characters');
  assert.deepEqual(longSocketPath(wide), { path: runPaths(wide).brokerSocket, bytes: 105 });
  const control = join('/', 'r'.repeat(100));
  assert.deepEqual(longSocketPath(control), { path: runPaths(control).control, bytes: Buffer.byteLength(runPaths(control).control) });
});

test('ms install and its dry run refuse a socket path over 103 bytes with the path, its length and the limit', async () => {
  const source = await makeSource();
  const home = homeFor(110);
  const env = makeEnv(home, source);
  const socket = runPaths(env.paths.root).brokerSocket;
  await assert.rejects(planInstall(env), (error: CliError) => error.code === 'MS_SOCKET_PATH_TOO_LONG'
    && error.detail === `${socket} is 110 bytes; macOS allows at most 103 bytes for a Unix socket path`);
  assert.equal(exitCodeFor('MS_SOCKET_PATH_TOO_LONG'), 5);
});

test('msd refuses to start under a root whose socket path is too long, before touching it', async () => {
  const root = resolvePaths(homeFor(104)).root;
  await assert.rejects(startMsd({ root }), { message: 'MS_SOCKET_PATH_TOO_LONG' });
});
