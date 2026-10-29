// INPUT: Synthetic ms ui snapshots and fixed clock values.
// OUTPUT: Regressions for the page's pure view rules: overview counts and connection pills (by sessions online for all three),
//         grouping, the online filter, sorting, labels and time/size formatting.
// POS: Pure tests of src/cli/ui/assets/view.js (loaded the way the browser loads it, as an ES module); no DOM, server or msd.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const view: any = await import(new URL('../../src/cli/ui/assets/view.js', import.meta.url).href);

const harness = (id: string, extra: Record<string, unknown>) => ({ harness: id, label: { 'claude-code': 'Claude Code', dsh: 'DSH', codex: 'Codex' }[id],
  installed: true, online: 0, offline: 0, connection: id === 'claude-code' ? { kind: 'sessions' } : { kind: 'adapter', attached: 0 },
  replyMode: 'direct', actPreset: 'workspace-write', actPresetLabel: '工作区内修改', autoRegister: false, ...extra });
const session = (id: string, extra: Record<string, unknown>) => ({ harness: 'claude-code', sessionId: id, alias: null, title: null,
  surface: 'cli', project: null, online: true, at: '2026-10-28T09:00:00.000Z', ...extra });
const SNAPSHOT = {
  installed: { 'claude-code': true, dsh: true, codex: false },
  daemon: { state: 'running', version: '0.4.0', startedAt: '2026-10-28T06:30:00.000Z' },
  harnesses: [harness('claude-code', { online: 2, offline: 1 }), harness('dsh', { online: 1, connection: { kind: 'adapter', attached: 1 } }),
    harness('codex', { installed: false, offline: 1 })],
  autoRegisterProjects: [],
  links: { total: 3, paused: 1, suspended: 1, rows: [] },
  sessions: [
    session('a', { project: '~/work/api', at: '2026-10-28T08:00:00.000Z' }),
    session('b', { project: '~/work/web', online: false, at: '2026-10-28T09:30:00.000Z' }),
    session('c', { project: '~/work/api', at: '2026-10-28T09:10:00.000Z' }),
    session('d', { harness: 'dsh', project: null }),
    session('e', { harness: 'codex', project: '~/work/api', online: false }),
  ],
  messages: [],
};

// All three cards and the overview go by sessions online; the connection row says how each
// harness is connected, never in warn colour.
test('overview counts the harnesses with a session online, whatever is attached', () => {
  assert.deepEqual(view.overview(SNAPSHOT), { online: 3, offline: 2, withOnline: 2, harnesses: 3, links: 3, paused: 1 });
  const attachedOnly = { ...SNAPSHOT, harnesses: [harness('claude-code', {}), harness('dsh', { connection: { kind: 'adapter', attached: 1 } }),
    harness('codex', { connection: { kind: 'adapter', attached: 2 } })] };
  assert.equal(view.overview(attachedOnly).withOnline, 0);
  assert.deepEqual(SNAPSHOT.harnesses.map(view.hasOnline), [true, true, false]);
});

const adapter = (attached: number) => ({ connection: { kind: 'adapter', attached } });
const NO_SESSIONS = '已安装 · 没有在线会话';
const CLAUDE = '不常驻连接，按会话登记';
const DSH_OFF = 'DSH 插件没连上（DSH 没打开？）';
const CODEX_OFF = '没有打开的 Codex 会话（打开会话后几秒内连上）';
const CASES: ReadonlyArray<readonly [string, string, Record<string, unknown>, Record<string, string>]> = [
  ['Claude online', 'claude-code', { online: 2 }, { tone: 'ok', pill: '2 个会话在线', text: CLAUDE }],
  ['Claude online, installed by hand', 'claude-code', { online: 1, installed: false }, { tone: 'ok', pill: '1 个会话在线', text: CLAUDE }],
  ['Claude installed, none online', 'claude-code', {}, { tone: '', pill: NO_SESSIONS, text: CLAUDE }],
  ['Claude not installed', 'claude-code', { installed: false }, { tone: '', pill: '未安装', text: '没有用 ms 安装' }],
  ['Claude ledger unreadable', 'claude-code', { installed: null }, { tone: '', pill: '安装情况未知', text: '读不到安装账本' }],
  ['DSH attached, none online', 'dsh', adapter(1), { tone: '', pill: NO_SESSIONS, text: 'DSH 插件已连上' }],
  ['DSH attached twice, one online', 'dsh', { ...adapter(2), online: 1 }, { tone: 'ok', pill: '1 个会话在线', text: 'DSH 插件已连上（2 个实例）' }],
  ['DSH installed, not attached', 'dsh', {}, { tone: '', pill: NO_SESSIONS, text: DSH_OFF }],
  ['DSH installed by hand, attached', 'dsh', { ...adapter(1), installed: false }, { tone: '', pill: NO_SESSIONS, text: 'DSH 插件已连上' }],
  ['DSH not installed', 'dsh', { installed: false }, { tone: '', pill: '未安装', text: '没有用 ms 安装' }],
  ['DSH ledger unreadable, attached', 'dsh', { ...adapter(1), installed: null }, { tone: '', pill: NO_SESSIONS, text: 'DSH 插件已连上' }],
  ['DSH ledger unreadable', 'dsh', { installed: null }, { tone: '', pill: '安装情况未知', text: '读不到安装账本' }],
  ['Codex attached, none online', 'codex', adapter(1), { tone: '', pill: NO_SESSIONS, text: '1 个 Codex 会话进程已连上' }],
  ['Codex online, installed by hand', 'codex', { ...adapter(2), online: 3, installed: false },
    { tone: 'ok', pill: '3 个会话在线', text: '2 个 Codex 会话进程已连上' }],
  ['Codex installed, no open session', 'codex', {}, { tone: '', pill: NO_SESSIONS, text: CODEX_OFF }],
  ['Codex not installed', 'codex', { installed: false }, { tone: '', pill: '未安装', text: '没有用 ms 安装' }],
];

test('connection pills go by sessions online; installed means the ledger, an attached adapter or a session online', () => {
  for (const [name, id, extra, expected] of CASES) assert.deepEqual(view.connection(harness(id, extra)), expected, name);
  assert.ok(CASES.every(([, , , expected]) => expected.tone !== 'warn'), 'no card is ever in warn colour');
  assert.deepEqual([true, false, null].map(view.installText), ['已用 ms 安装', '没有用 ms 安装', '读不到安装账本']);
});

test('grouping by harness keeps the fixed order and empty groups; the online filter hides rows but not the group counts', () => {
  const groups = view.groups(SNAPSHOT, 'harness', false);
  assert.deepEqual(groups.map((group: any) => [group.title, group.mono, group.online, group.offline, group.rows.map((row: any) => row.sessionId),
    group.empty]), [
    ['Claude Code', false, 2, 1, ['c', 'a', 'b'], null],
    ['DSH', false, 1, 0, ['d'], null],
    ['Codex', false, 0, 1, ['e'], null],
  ]);
  const online = view.groups(SNAPSHOT, 'harness', true);
  assert.deepEqual(online.map((group: any) => [group.online, group.offline, group.rows.length, group.empty]),
    [[2, 1, 2, null], [1, 0, 1, null], [0, 1, 0, '没有在线会话']]);
  const lonely = view.groups({ ...SNAPSHOT, sessions: [SNAPSHOT.sessions[0]] }, 'harness', false);
  assert.deepEqual(lonely.map((group: any) => group.empty), [null, '没有登记的会话', '没有登记的会话']);
});

test('grouping by project sorts the paths, puts sessions without a project last and asks for the harness column', () => {
  const groups = view.groups(SNAPSHOT, 'project', false);
  assert.deepEqual(groups.map((group: any) => [group.title, group.mono, group.rows.map((row: any) => row.sessionId)]), [
    ['~/work/api', true, ['c', 'a', 'e']], ['~/work/web', true, ['b']], ['没有识别出项目', false, ['d']],
  ]);
  assert.equal(view.withHarness('project'), true);
  assert.equal(view.withHarness('harness'), false);
});

test('names fall back from alias to title to 未命名会话, endpoints to the first 8 characters of the id', () => {
  assert.equal(view.displayName(session('x', { alias: 'r', title: 't' })), 'r');
  assert.equal(view.displayName(session('x', { title: 't' })), 't');
  assert.equal(view.displayName(session('x', {})), '未命名会话');
  assert.equal(view.endpointName({ harness: 'dsh', sessionId: '0123456789ab', name: null }), '01234567');
  assert.equal(view.endpointName({ harness: 'dsh', sessionId: '0123456789ab', name: '联调' }), '联调');
  assert.equal(view.shortId('0123456789ab'), '01234567');
  assert.equal(view.harnessLabel('codex'), 'Codex');
});

test('labels for reply modes, auto-register, link and message states and the daemon pill', () => {
  assert.deepEqual(['direct', 'confirm', 'act'].map(mode => view.REPLY_LABELS[mode]), ['direct（只回答）', 'confirm（先问你）', 'act（可以动手）']);
  assert.equal(view.autoText(harness('dsh', { autoRegister: true }), []), '开（全部项目）');
  assert.equal(view.autoText(harness('dsh', { autoRegister: true }), ['~/a', '/b']), '开（~/a、/b）');
  assert.equal(view.autoText(harness('dsh', {}), ['~/a']), '关');
  assert.deepEqual(view.linkState({ paused: true, suspended: true }), ['warn', '已暂停（推送预算）']);
  assert.deepEqual(view.linkState({ paused: false, suspended: true }), ['', '挂起（有一端离线）']);
  assert.deepEqual(view.linkState({ paused: false, suspended: false }), ['ok', '正常']);
  assert.deepEqual(['dispatched', 'pending', 'delivery-unknown', 'undelivered', 'other'].map(view.messageState),
    [['ok', '已投递'], ['warn', '投递中'], ['warn', '结果未知'], ['bad', '未投递'], ['', 'other']]);
  const now = Date.parse('2026-10-28T09:45:00.000Z');
  assert.deepEqual(view.daemonPill(null, now), ['', '正在读取…']);
  assert.deepEqual(view.daemonPill({ daemon: { state: 'down' } }, now), ['bad', 'msd 未运行']);
  assert.deepEqual(view.daemonPill({ daemon: { state: 'error', code: 'DAEMON_TIMEOUT' } }, now), ['warn', 'msd 读不到']);
  assert.deepEqual(view.daemonPill(SNAPSHOT, now), ['ok', 'msd 运行中 · v0.4.0 · 已运行 3 小时 15 分']);
  assert.deepEqual(view.REGISTER_COMMANDS, [['Claude Code', '/ms:register'], ['DSH', '/ms-register'], ['Codex', '$ms-register']]);
});

test('times read as 刚刚, minutes, 今天, 昨天 or days by the local calendar, durations and sizes in short units', () => {
  const now = new Date(2026, 9, 28, 10, 30).getTime();
  const at = (date: Date) => date.toISOString();
  assert.equal(view.when(at(new Date(2026, 9, 28, 10, 29, 40)), now), '刚刚');
  assert.equal(view.when(at(new Date(2026, 9, 28, 10, 31)), now), '刚刚');
  assert.equal(view.when(at(new Date(2026, 9, 28, 10, 5)), now), '25 分钟前');
  assert.equal(view.when(at(new Date(2026, 9, 28, 0, 5)), now), '今天 00:05');
  assert.equal(view.when(at(new Date(2026, 9, 27, 23, 50)), now), '昨天 23:50');
  assert.equal(view.when(at(new Date(2026, 9, 25, 12, 0)), now), '3 天前');
  assert.equal(view.clock(new Date(2026, 9, 28, 7, 3, 9).getTime(), true), '07:03:09');
  assert.equal(view.uptime(at(new Date(2026, 9, 28, 10, 2)), now), '28 分钟');
  assert.equal(view.uptime(at(new Date(2026, 9, 26, 8, 0)), now), '2 天 2 小时');
  assert.deepEqual([0, 1023, 1024, 2150, 5 * 1024 * 1024].map(view.bytes), ['0 B', '1023 B', '1.0 KB', '2.1 KB', '5.0 MB']);
});
