// INPUT: Synthetic hook data, private route files, test sockets and process snapshots.
// OUTPUT: Private ownership, ambiguous targets and stale route regressions without a model.
// POS: Offline target-binding tests, not real CLI acceptance proof.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import net from 'node:net';
import { mkdtemp, readFile, writeFile, rm, chmod, symlink } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { registerClaude, readClaude } from '../../src/adapters/claude/registration.ts';

const sid = '00000000-0000-0000-0000-000000000001';
const owner = { pid: 77, parent: 1, command: '/fixture/2.1.295', start: 'synthetic-start' };
const inspect = (pid: number) => pid === 77 ? owner : null;

for (const collision of ['owner', 'socket', 'both']) {
  test(`all targets sharing ${collision} are rejected instead of choosing newest`, async () => {
    const root = await mkdtemp('/tmp/ms-reg-');
    const sockets = [join(root, 'first.sock'), join(root, 'second.sock')];
    const servers = sockets.map(() => net.createServer(s => s.end()));
    const secondSid = '00000000-0000-0000-0000-000000000002';
    const secondOwner = collision === 'socket' ? { ...owner, pid: 88 } : owner;
    const lookup = (pid: number) => pid === 77 ? owner : pid === 88 ? secondOwner : null;
    try {
      for (const [i, server] of servers.entries()) { server.listen(sockets[i]); await once(server, 'listening'); }
      await registerClaude(root, { session_id: sid }, sockets[0], 77, lookup);
      await registerClaude(root, { session_id: secondSid }, collision === 'owner' ? sockets[1] : sockets[0], secondOwner.pid, lookup);
      await assert.rejects(readClaude(root, sid, lookup), /TARGET_UNAVAILABLE/);
      await assert.rejects(readClaude(root, secondSid, lookup), /TARGET_UNAVAILABLE/);
    } finally {
      for (const server of servers) await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true });
    }
  });
}

test('separate process and socket registrations remain independently addressable', async () => {
  const root = await mkdtemp('/tmp/ms-reg-');
  const sockets = [join(root, 'first.sock'), join(root, 'second.sock')];
  const servers = sockets.map(() => net.createServer(s => s.end()));
  const ids = [sid, '00000000-0000-0000-0000-000000000002'];
  const owners = [owner, { ...owner, pid: 88 }];
  const lookup = (pid: number) => owners.find(item => item.pid === pid) ?? null;
  try {
    for (const [i, server] of servers.entries()) { server.listen(sockets[i]); await once(server, 'listening'); }
    for (const [i, id] of ids.entries()) await registerClaude(root, { session_id: id }, sockets[i], owners[i].pid, lookup);
    for (const id of ids) assert.equal((await readClaude(root, id, lookup)).endpoint.nativeSessionId, id);
  } finally {
    for (const server of servers) await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true });
  }
});

test('private registration binds endpoint and owner, excludes token and rejects stale owner', async () => {
  const root = await mkdtemp('/tmp/ms-reg-');
  const socket = join(root, 'native.sock');
  const server = net.createServer(s => s.end());
  try {
    server.listen(socket); await once(server, 'listening');
    const route = await registerClaude(root, { session_id: sid, transcript_path: 'ignored', token: 'never-copy' }, socket, 77, inspect);
    const saved = JSON.parse(await readFile(join(root, sid + '.json'), 'utf8'));
    assert.equal(JSON.stringify(saved).includes('never-copy'), false);
    assert.equal(JSON.stringify(saved).includes('transcript_path'), false);
    assert.equal(route.endpoint.nativeSessionId, sid);
    assert.equal(route.endpoint.harness, 'claude-code');
    assert.ok(Object.isFrozen(route.endpoint));
    assert.deepEqual(await readClaude(root, sid, inspect), route);
    await assert.rejects(registerClaude(root, { session_id: sid }, socket, 77, inspect), /DUPLICATE_SESSION/);
    assert.deepEqual(await readClaude(root, sid, inspect), route);
    await assert.rejects(readClaude(root, sid, () => null), /TARGET_UNAVAILABLE/);
    await assert.rejects(readClaude(root, sid, () => ({ ...owner, start: 'reused' })), /TARGET_UNAVAILABLE/);
    for (const invalid of [{ ...saved, token: 'injected' }, { ...saved, ownerStart: '' },
      { ...saved, endpoint: { ...saved.endpoint, nativeSessionId: 'wrong' } }]) {
      await writeFile(join(root, sid + '.json'), JSON.stringify(invalid));
      await assert.rejects(readClaude(root, sid, inspect), /INVALID_ROUTE/);
    }
    await writeFile(join(root, sid + '.json'), JSON.stringify(saved));
    await chmod(join(root, sid + '.json'), 0o644);
    await assert.rejects(readClaude(root, sid, inspect), /INVALID_ROUTE/);
    await rm(join(root, sid + '.json'));
    await symlink(socket, join(root, sid + '.json'));
    await assert.rejects(readClaude(root, sid, inspect));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true }); }
});

test('missing socket, bad session and non-CLI ancestor cannot register', async () => {
  const root = await mkdtemp('/tmp/ms-reg-');
  try {
    await assert.rejects(registerClaude(root, { session_id: '../escape' }, join(root, 'missing.sock'), 77, inspect), /INVALID_SESSION/);
    await assert.rejects(registerClaude(root, { session_id: sid }, join(root, 'missing.sock'), 77,
      () => ({ ...owner, command: '/fixture/not-claude' })), /INVALID_OWNER/);
    await assert.rejects(registerClaude(root, { session_id: sid }, join(root, 'missing.sock'), 88, () => null), /INVALID_OWNER/);
    await assert.rejects(registerClaude(root, { session_id: sid }, join(root, 'missing.sock'), 88,
      pid => ({ ...owner, pid, parent: pid, command: '/fixture/shell' })), /INVALID_OWNER/);
    await assert.rejects(registerClaude(root, { session_id: sid }, join(root, 'missing.sock'), 77, inspect));
    await chmod(root, 0o755);
    await assert.rejects(registerClaude(root, { session_id: sid }, join(root, 'missing.sock'), 77, inspect), /INVALID_DIRECTORY/);
    await assert.rejects(readClaude(root, '../escape', inspect), /INVALID_SESSION/);
  } finally { await rm(root, { recursive: true }); }
});
