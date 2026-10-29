// INPUT: Synthetic kernel tokens, trusted classifiers and changing process snapshots.
// OUTPUT: Nearest pinned CLI and fail-closed ancestry/identity regressions without OS calls.
// POS: Pure peer authentication contract tests; not real kernel authentication evidence.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveClaudePeer as resolveNativePeer, type ProcessSnapshot } from '../../src/adapters/claude/peer-identity.ts';

const hash = 'a'.repeat(64);
const pin = { path: '/fixture/2.1.295', sha256: hash };
const cli: ProcessSnapshot = { pid: 77, parentPid: 1, uid: 501, pidVersion: 12,
  uniqueId: '18446744073709551614', parentUniqueId: '1', exe: pin.path, sha256: hash };
const shell: ProcessSnapshot = { ...cli, pid: 88, parentPid: 77, pidVersion: 13,
  uniqueId: '18446744073709551613', parentUniqueId: cli.uniqueId, exe: '/fixture/shell' };
const helper: ProcessSnapshot = { ...shell, pid: 99, parentPid: 88, pidVersion: 14,
  uniqueId: '18446744073709551612', parentUniqueId: shell.uniqueId, exe: '/fixture/helper' };
const token = { pid: helper.pid, uid: helper.uid, pidVersion: helper.pidVersion };
const classify = (snapshot: ProcessSnapshot) => snapshot.exe === '/fixture/shell'
  || snapshot.exe === '/fixture/helper' ? 'wrapper' as const : 'cli' as const;
const resolveClaudePeer = (peer: Parameters<typeof resolveNativePeer>[0],
  lookup: (pid: number) => ProcessSnapshot | null, classify: Parameters<typeof resolveNativePeer>[2],
  pin: Parameters<typeof resolveNativePeer>[3]) => resolveNativePeer(peer, async pid => lookup(pid), classify, pin);
const inspect = (rows: readonly ProcessSnapshot[]) => (pid: number) => rows.find(row => row.pid === pid) ?? null;

test('resolves the nearest pinned CLI through validated wrappers with lossless uint64 identity', async () => {
  let resolved: ProcessSnapshot | undefined;
  resolved = await resolveClaudePeer(token, inspect([helper, shell, cli]), classify, pin);
  assert.deepEqual(resolved, cli);
  assert.equal(Object.isFrozen(resolved), true);
  assert.notEqual(resolved, cli);
});

test('the CLI itself can be the kernel peer', async () => {
  assert.deepEqual(await resolveClaudePeer({ pid: cli.pid, uid: cli.uid, pidVersion: cli.pidVersion },
    inspect([cli]), classify, pin), cli);
});

for (const [name, changed] of [
  ['peer PID reuse', { ...helper, pidVersion: 15 }],
  ['peer UID mismatch', { ...helper, uid: 502 }],
  ['ancestor UID mismatch', { ...shell, uid: 502 }],
  ['parent unique mismatch', { ...helper, parentUniqueId: '2' }],
  ['parent PID mismatch', { ...helper, parentPid: 78 }],
  ['cycle', { ...shell, parentPid: helper.pid, parentUniqueId: helper.uniqueId }],
] as const) {
  test(`rejects ${name}`, async () => {
    const rows = [helper, shell, cli].map(row => row.pid === changed.pid ? changed : row);
    await assert.rejects(() => resolveClaudePeer(token, inspect(rows), classify, pin), /INVALID_PEER_IDENTITY/);
  });
}

for (const change of [{ exe: '/fixture/2.1.296' }, { exe: '/shadow/2.1.295' }, { sha256: 'b'.repeat(64) }]) {
  test(`does not skip a nearer unsupported CLI: ${JSON.stringify(change)}`, async () => {
    const near = { ...shell, exe: pin.path, ...change, parentUniqueId: cli.uniqueId };
    await assert.rejects(() => resolveClaudePeer(token, inspect([helper, near, cli]), classify, pin), /UNSUPPORTED_CLAUDE_BINARY/);
  });
}

test('returns a nearest valid CLI even when an outer CLI exists, leaving registration to epoch verification', async () => {
  const near = { ...shell, exe: pin.path };
  assert.deepEqual(await resolveClaudePeer(token, inspect([helper, near, cli]), classify, pin), near);
});

for (const classification of ['unsupported', 'unknown'] as const) {
  test(`rejects ${classification} ancestry without examining an outer CLI`, async () => {
    let outerReads = 0;
    const lookup = (pid: number) => { if (pid === cli.pid) outerReads++; return inspect([helper, shell, cli])(pid); };
    await assert.rejects(() => resolveClaudePeer(token, lookup,
      () => classification as 'unsupported', pin), /UNSUPPORTED_PEER_ANCESTRY/);
    assert.equal(outerReads, 0);
  });
}

test('rejects launchd without a classified CLI', async () => {
  await assert.rejects(() => resolveClaudePeer(token, inspect([helper, shell, cli]), () => 'wrapper', pin), /INVALID_PEER_IDENTITY/);
});

for (const field of ['parentPid', 'parentUniqueId', 'pidVersion', 'uniqueId', 'uid', 'exe', 'sha256'] as const) {
  test(`rejects ${field} changing between ancestry verification passes`, async () => {
    const counts = new Map<number, number>();
    const lookup = (pid: number) => {
      const count = (counts.get(pid) ?? 0) + 1; counts.set(pid, count);
      const row = inspect([helper, shell, cli])(pid);
      if (pid !== shell.pid || !row || count === 1) return row;
      const value = typeof row[field] === 'number' ? Number(row[field]) + 1 : row[field] + '1';
      return { ...row, [field]: value };
    };
    await assert.rejects(() => resolveClaudePeer(token, lookup, classify, pin), /INVALID_PEER_IDENTITY/);
  });
}

test('rejects a process disappearing on the verification pass', async () => {
  let reads = 0;
  await assert.rejects(() => resolveClaudePeer(token, pid => pid === helper.pid && ++reads === 2
    ? null : inspect([helper, shell, cli])(pid), classify, pin), /INVALID_PEER_IDENTITY/);
});

test('rejects duplicate unique IDs across different processes', async () => {
  const changedHelper = { ...helper, uniqueId: shell.uniqueId };
  await assert.rejects(() => resolveClaudePeer(token, inspect([changedHelper, shell, cli]), classify, pin), /INVALID_PEER_IDENTITY/);
});

for (const bad of [{ ...helper, pid: 100 }, { ...helper, parentUniqueId: '0' },
  { ...helper, exe: 'helper' }, { ...helper, sha256: 'not-a-hash' }]) {
  test(`rejects malformed process snapshot ${JSON.stringify(bad)}`, async () => {
    const lookup = (pid: number) => pid === helper.pid ? bad : inspect([shell, cli])(pid);
    await assert.rejects(() => resolveClaudePeer(token, lookup, classify, pin), /INVALID_PEER_IDENTITY/);
  });
}

for (const bad of [{ path: '2.1.295', sha256: hash }, { path: pin.path, sha256: 'bad' }]) {
  test(`rejects an unpinned classifier target ${JSON.stringify(bad)}`, async () => {
    await assert.rejects(() => resolveClaudePeer(token, inspect([helper, shell, cli]), classify, bad), /UNSUPPORTED_CLAUDE_BINARY/);
  });
}

for (const uniqueId of ['0', '01', '-1', '1.0', '18446744073709551616', ' 1', 1]) {
  test(`rejects noncanonical uint64 identity ${JSON.stringify(uniqueId)}`, async () => {
    const bad = { ...helper, uniqueId } as ProcessSnapshot;
    await assert.rejects(() => resolveClaudePeer(token, inspect([bad, shell, cli]), classify, pin), /INVALID_PEER_IDENTITY/);
  });
}

for (const bad of [{ ...token, pid: 1 }, { ...token, pid: 1.5 }, { ...token, uid: -1 },
  { ...token, pidVersion: -1 }, { ...token, pidVersion: 2 ** 32 }]) {
  test(`rejects invalid trusted adapter token ${JSON.stringify(bad)}`, async () => {
    await assert.rejects(() => resolveClaudePeer(bad, inspect([helper, shell, cli]), classify, pin), /INVALID_PEER_IDENTITY/);
  });
}

test('freezes copied snapshots before the trusted classifier sees them', async () => {
  const result = await resolveClaudePeer(token, inspect([helper, shell, cli]), snapshot => {
    assert.equal(Object.isFrozen(snapshot), true);
    assert.notEqual(snapshot, inspect([helper, shell, cli])(snapshot.pid));
    return classify(snapshot);
  }, pin);
  assert.deepEqual(result, cli);
});


test('delayed OS reads must settle before identity can resolve', async () => {
  const gate = Promise.withResolvers<ProcessSnapshot>();
  let complete = false;
  const pending = resolveNativePeer({ pid: cli.pid, uid: cli.uid, pidVersion: cli.pidVersion },
    async () => gate.promise, classify, pin).then(value => { complete = true; return value; });
  await Promise.resolve(); assert.equal(complete, false);
  gate.resolve(cli); assert.deepEqual(await pending, cli);
});

test('rejected live OS reads cannot authenticate or yield an unhandled Promise', async () => {
  await assert.rejects(resolveNativePeer(token, async () => { throw new Error('OS_READ_FAILED'); }, classify, pin),
    /OS_READ_FAILED/);
});
