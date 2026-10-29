// INPUT: A fake msd on a private socket answering by method, synthetic contacts/links/messages and temporary install manifests.
// OUTPUT: Regressions for the ms ui read-only allowlist, the daemon down/error states, result-shape checks, the install rule and the
//         snapshot mapping (counts, connection inputs, ~ shortening, endpoint names, labels).
// POS: Offline tests of src/cli/ui/snapshot.ts; no real msd, HOME or host.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { callControl } from '../../src/cli/control-client.ts';
import { resolvePaths } from '../../src/cli/paths.ts';
import { installedHarnesses, READ_ONLY_METHODS, readOnly, readSnapshot } from '../../src/cli/ui/snapshot.ts';
import { errorReply, startFakeDaemon, type FakeRequest } from './fake-daemon.ts';

const HOME = '/Users/me';
const STATUS = {
  version: '0.4.0', startedAt: '2026-10-28T08:00:00.000Z',
  sessions: { 'claude-code': { online: 2, offline: 1 }, dsh: { online: 1, offline: 0 }, codex: { online: 0, offline: 1 } },
  links: { total: 2, suspended: 1, paused: 1 }, autoRegister: { 'claude-code': false, dsh: true, codex: false },
  autoRegisterProjects: ['/Users/me/work/api', '/opt/other'],
  replyMode: { 'claude-code': 'act', dsh: 'direct', codex: 'confirm' },
  actPreset: { 'claude-code': 'workspace-write', dsh: 'read-only', codex: 'full-access' }, adapters: { dsh: 1, codex: 0 },
};
const contact = (harness: string, sessionId: string, extra: Record<string, unknown>) => ({
  harness, sessionId, clientSurface: 'cli', title: null, cwd: null, project: null, alias: null, online: true,
  registeredAt: '2026-10-28T07:00:00.000Z', lastSeenAt: '2026-10-28T09:00:00.000Z', ...extra,
});
const SESSIONS = [
  contact('claude-code', 'c1-aaaaaaaa-0000', { alias: 'reviewer', title: '<img src=x onerror=alert(1)>', project: '/Users/me/work/api' }),
  contact('claude-code', 'c2-bbbbbbbb-0000', { title: '  ', project: '/Users/me2/work/web', clientSurface: 'desktop' }),
  contact('claude-code', 'c3-cccccccc-0000', { title: '写发布说明', project: '/Users/me', online: false, lastSeenAt: '2026-10-27T09:00:00.000Z' }),
  contact('dsh', 'd1-dddddddd-0000', { title: '接口联调', project: null, clientSurface: 'desktop' }),
  contact('codex', 'x1-eeeeeeee-0000', { online: false }),
];
const LINKS = [
  { linkId: 'L1', a: { harness: 'claude-code', sessionId: 'c1-aaaaaaaa-0000' }, b: { harness: 'dsh', sessionId: 'd1-dddddddd-0000' },
    messages: 2, paused: true, suspended: false },
  { linkId: 'L2', a: { harness: 'claude-code', sessionId: 'c2-bbbbbbbb-0000' }, b: { harness: 'codex', sessionId: 'gone-ffffffff' },
    messages: 0, paused: false, suspended: true },
];
const MESSAGES = [{ messageId: 'M1', linkId: 'L1', from: { harness: 'dsh', sessionId: 'd1-dddddddd-0000' },
  to: { harness: 'claude-code', sessionId: 'c1-aaaaaaaa-0000' }, sentAt: '2026-10-28T09:01:00.000Z', state: 'delivery-unknown', bytes: 2150 }];
const RESULTS: Record<string, unknown> = { status: STATUS, 'sessions.list': SESSIONS, 'links.list': LINKS, 'messages.list': MESSAGES };

const answer = (results: Record<string, unknown>) => (request: FakeRequest) =>
  ({ schemaVersion: 1, id: request.id, ok: true, result: results[request.method as string] });
const ALL = { 'claude-code': true, dsh: true, codex: false };

async function snapshotWith(reply: Parameters<typeof startFakeDaemon>[0], installed: unknown = ALL) {
  const daemon = await startFakeDaemon(reply);
  try {
    const snapshot = await readSnapshot({ home: HOME, installed: async () => installed as never,
      control: (method, params) => callControl(daemon.socketPath, method, params, { timeoutMs: 300 }) });
    return { snapshot: snapshot as Record<string, any>, requests: daemon.requests };
  } finally { await daemon.close(); }
}

test('the allowlist is exactly the four reads and refuses everything else before it reaches msd', async () => {
  assert.deepEqual(READ_ONLY_METHODS, ['status', 'sessions.list', 'links.list', 'messages.list']);
  const calls: string[] = [];
  const call = readOnly(async method => { calls.push(method); return 'ok'; });
  for (const method of ['config.set', 'config.reload', 'config.get', 'sessions.unregister', 'sessions.alias', 'links.resume',
    'adapter.attach', 'projects.list', 'send', 'reply', 'constructor', '']) {
    await assert.rejects(call(method, {}), { code: 'UI_METHOD_REFUSED' }, method);
  }
  assert.deepEqual(calls, []);
  assert.equal(await call('links.list', {}), 'ok');
  assert.deepEqual(calls, ['links.list']);
});

test('a running msd maps to the page snapshot with fixed calls, counts, labels, ~ paths and endpoint names', async () => {
  const { snapshot, requests } = await snapshotWith(answer(RESULTS));
  assert.deepEqual(requests.map(request => [request.method, request.params]).sort(),
    [['links.list', {}], ['messages.list', { limit: 20 }], ['sessions.list', {}], ['status', {}]]);
  assert.deepEqual(snapshot.daemon, { state: 'running', version: '0.4.0', startedAt: '2026-10-28T08:00:00.000Z' });
  assert.deepEqual(snapshot.installed, ALL);
  assert.deepEqual(snapshot.harnesses, [
    { harness: 'claude-code', label: 'Claude Code', installed: true, online: 2, offline: 1, connection: { kind: 'sessions' },
      replyMode: 'act', actPreset: 'workspace-write', actPresetLabel: '工作区内修改', autoRegister: false },
    { harness: 'dsh', label: 'DSH', installed: true, online: 1, offline: 0, connection: { kind: 'adapter', attached: 1 },
      replyMode: 'direct', actPreset: 'read-only', actPresetLabel: '仅可查看', autoRegister: true },
    { harness: 'codex', label: 'Codex', installed: false, online: 0, offline: 1, connection: { kind: 'adapter', attached: 0 },
      replyMode: 'confirm', actPreset: 'full-access', actPresetLabel: '完全权限', autoRegister: false },
  ]);
  assert.deepEqual(snapshot.autoRegisterProjects, ['~/work/api', '/opt/other']);
  assert.deepEqual(snapshot.sessions.map((row: Record<string, unknown>) => [row.sessionId, row.alias, row.title, row.surface, row.project,
    row.online, row.at]), [
    ['c1-aaaaaaaa-0000', 'reviewer', '<img src=x onerror=alert(1)>', 'cli', '~/work/api', true, '2026-10-28T09:00:00.000Z'],
    ['c2-bbbbbbbb-0000', null, null, 'desktop', '/Users/me2/work/web', true, '2026-10-28T09:00:00.000Z'],
    ['c3-cccccccc-0000', null, '写发布说明', 'cli', '~', false, '2026-10-27T09:00:00.000Z'],
    ['d1-dddddddd-0000', null, '接口联调', 'desktop', null, true, '2026-10-28T09:00:00.000Z'],
    ['x1-eeeeeeee-0000', null, null, 'cli', null, false, '2026-10-28T09:00:00.000Z'],
  ]);
  assert.deepEqual(snapshot.sessions[0].harness, 'claude-code');
  assert.deepEqual(snapshot.links, { total: 2, paused: 1, suspended: 1, rows: [
    { linkId: 'L1', a: { harness: 'claude-code', sessionId: 'c1-aaaaaaaa-0000', name: 'reviewer' },
      b: { harness: 'dsh', sessionId: 'd1-dddddddd-0000', name: '接口联调' }, messages: 2, paused: true, suspended: false },
    { linkId: 'L2', a: { harness: 'claude-code', sessionId: 'c2-bbbbbbbb-0000', name: null },
      b: { harness: 'codex', sessionId: 'gone-ffffffff', name: null }, messages: 0, paused: false, suspended: true },
  ] });
  assert.deepEqual(snapshot.messages, [{ messageId: 'M1', sentAt: '2026-10-28T09:01:00.000Z',
    from: { harness: 'dsh', sessionId: 'd1-dddddddd-0000', name: '接口联调' },
    to: { harness: 'claude-code', sessionId: 'c1-aaaaaaaa-0000', name: 'reviewer' }, bytes: 2150, state: 'delivery-unknown' }]);
});

test('an unknown install state passes through as null on every card', async () => {
  const { snapshot } = await snapshotWith(answer(RESULTS), null);
  assert.equal(snapshot.installed, null);
  assert.deepEqual(snapshot.harnesses.map((item: { installed: unknown }) => item.installed), [null, null, null]);
});

test('msd that is not running is the down state with only the install facts', async () => {
  const snapshot = await readSnapshot({ home: HOME, installed: async () => ALL,
    control: (method, params) => callControl('/tmp/ms-ui-absent/msd.sock', method, params, { timeoutMs: 300 }) });
  assert.deepEqual(snapshot, { installed: ALL, daemon: { state: 'down' } });
});

test('a timeout, a daemon error or a result outside the contract is the error state with its code, never half a snapshot', async () => {
  assert.deepEqual((await snapshotWith('hang')).snapshot, { installed: ALL, daemon: { state: 'error', code: 'DAEMON_TIMEOUT' } });
  assert.deepEqual((await snapshotWith(errorReply('RUNTIME_PIN_MISMATCH'))).snapshot,
    { installed: ALL, daemon: { state: 'error', code: 'DAEMON_ERROR: RUNTIME_PIN_MISMATCH' } });
  for (const [method, bad] of [['status', { ...STATUS, adapters: { dsh: 1 } }], ['sessions.list', [{ ...SESSIONS[0], harness: 'web' }]],
    ['links.list', {}], ['messages.list', [{ ...MESSAGES[0], bytes: -1 }]]] as const) {
    assert.deepEqual((await snapshotWith(answer({ ...RESULTS, [method]: bad }))).snapshot,
      { installed: ALL, daemon: { state: 'error', code: 'DAEMON_PROTOCOL_INVALID' } }, method);
  }
});

test('installed follows the install ledger: a harness counts once a record carries its mark', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ms-ui-home-'));
  const paths = resolvePaths(home);
  assert.deepEqual(await installedHarnesses(paths), { 'claude-code': false, dsh: false, codex: false });
  await mkdir(paths.installDir, { recursive: true });
  const manifest = (records: unknown[], state = 'installed') =>
    writeFile(paths.manifest, JSON.stringify({ schemaVersion: 1, state, createdAt: 'x', bundle: null, records }));
  await manifest([{ kind: 'mkdir', path: '/a' }, { kind: 'create', path: '/b', sha256: 'c', harness: 'dsh' },
    { kind: 'tree', path: '/c', captured: true, files: [], harness: 'codex' }]);
  assert.deepEqual(await installedHarnesses(paths), { 'claude-code': false, dsh: true, codex: true });
  await manifest([{ kind: 'mkdir', path: '/a' }]);
  assert.deepEqual(await installedHarnesses(paths), { 'claude-code': false, dsh: false, codex: false });
  await writeFile(paths.manifest, '{not json');
  assert.equal(await installedHarnesses(paths), null);
});
