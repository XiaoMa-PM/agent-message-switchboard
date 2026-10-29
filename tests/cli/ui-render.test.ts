// INPUT: The ms ui page script (assets/app.js) on a fake DOM, synthetic snapshots (some with hostile titles) and a scripted fetch.
// OUTPUT: Regressions for text-only rendering, the down/error/empty/normal page states, the cards and overview (by sessions
//         online, installed or by hand, attached or not, never warn), view state kept across refreshes, the in-flight skip and the
//         stopped/auth/failed banners.
// POS: Offline tests of the browser side of ms ui; no browser, server or msd.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { elements, fakeDocument, texts, type FakeElement } from './fake-dom.ts';

const app: any = await import(new URL('../../src/cli/ui/assets/app.js', import.meta.url).href);

const IDS = ['daemon', 'tick', 'banner', 'main'];
const HOSTILE = '<img src=x onerror=alert(1)>';
const harness = (id: string, label: string, extra: Record<string, unknown> = {}) => ({ harness: id, label, installed: true, online: 1,
  offline: 0, connection: id === 'claude-code' ? { kind: 'sessions' } : { kind: 'adapter', attached: 1 }, replyMode: 'direct',
  actPreset: 'workspace-write', actPresetLabel: '工作区内修改', autoRegister: false, ...extra });
const endpoint = (harnessId: string, sessionId: string, name: string | null) => ({ harness: harnessId, sessionId, name });
const SNAPSHOT = {
  installed: { 'claude-code': true, dsh: true, codex: true },
  daemon: { state: 'running', version: '0.4.0', startedAt: '2026-10-28T06:30:00.000Z' },
  harnesses: [harness('claude-code', 'Claude Code'), harness('dsh', 'DSH', { autoRegister: true }), harness('codex', 'Codex', { online: 0, offline: 1 })],
  autoRegisterProjects: ['~/<b>proj</b>'],
  links: { total: 1, paused: 0, suspended: 0, rows: [{ linkId: 'L1', a: endpoint('claude-code', 'c1-aaaaaaaa', HOSTILE),
    b: endpoint('dsh', 'd1-bbbbbbbb', null), messages: 2, paused: false, suspended: false }] },
  sessions: [
    { harness: 'claude-code', sessionId: 'c1-aaaaaaaa-full', alias: '"><script>alert(1)</script>', title: HOSTILE, surface: 'cli',
      project: '~/<svg onload=alert(1)>', online: true, at: '2026-10-28T09:00:00.000Z' },
    { harness: 'dsh', sessionId: 'd1-bbbbbbbb-full', alias: null, title: '接口联调', surface: 'desktop', project: null, online: true,
      at: '2026-10-28T09:00:00.000Z' },
    { harness: 'codex', sessionId: 'x1-cccccccc-full', alias: null, title: null, surface: 'cli', project: '~/w', online: false,
      at: '2026-10-28T08:00:00.000Z' },
  ],
  messages: [{ messageId: 'M1', sentAt: '2026-10-28T09:01:00.000Z', from: endpoint('dsh', 'd1-bbbbbbbb', null),
    to: endpoint('claude-code', 'c1-aaaaaaaa', HOSTILE), bytes: 2150, state: 'dispatched' }],
};
const NOW = Date.parse('2026-10-28T09:45:00.000Z');
const VIEW = { groupBy: 'harness', onlineOnly: false, open: { links: true, messages: true } };

function draw(snapshot: unknown, view = VIEW) {
  const doc = fakeDocument(IDS);
  app.render(doc, { snapshot, banner: null, refreshedAt: null, view }, NOW, { choose: () => {}, keep: () => {} });
  return doc;
}

const main = (doc: ReturnType<typeof fakeDocument>) => doc.byId.get('main')!;
const all = (doc: ReturnType<typeof fakeDocument>) => IDS.flatMap(id => elements(doc.byId.get(id)!));
const text = (doc: ReturnType<typeof fakeDocument>) => IDS.map(id => texts(doc.byId.get(id)!).join('')).join('\n');
const find = (doc: ReturnType<typeof fakeDocument>, tag: string, match: (item: FakeElement) => boolean) =>
  all(doc).find(item => item.tagName === tag && match(item))!;

test('hostile titles, aliases, paths and endpoint names stay text: no element is ever built from them', () => {
  const doc = draw(SNAPSHOT);
  const tags = new Set(all(doc).map(item => item.tagName));
  for (const tag of ['IMG', 'SCRIPT', 'SVG', 'IFRAME', 'STYLE']) assert.equal(tags.has(tag), false, tag);
  const words = IDS.flatMap(id => texts(doc.byId.get(id)!));
  for (const raw of [HOSTILE, '"><script>alert(1)</script>', '~/<svg onload=alert(1)>']) assert.ok(words.includes(raw), raw);
  assert.match(text(doc), /开（~\/<b>proj<\/b>）/);
  const short = find(doc, 'TD', item => item.textContent === 'c1-aaaaa');
  assert.equal(short.getAttribute('title'), 'c1-aaaaaaaa-full');
  const allowed = new Set(['class', 'title', 'aria-pressed', 'type', 'data-k']);
  for (const item of all(doc)) for (const name of item.attributes.keys()) assert.ok(allowed.has(name), name);
});

test('the normal page has the overview, three cards, groups and both activity tables', () => {
  const words = text(draw(SNAPSHOT));
  for (const part of ['在线会话', '离线会话', '有会话在线的 Harness', '2 / 3', '线路', 'Claude Code', 'DSH 插件已连上', '已用 ms 安装',
    'direct（只回答）', '工作区内修改', '1 在线 / 0 离线', '按 Harness', '按项目', '只看在线', '未命名会话', '桌面', '上线于', '下线于',
    '最近消息', '已投递', '2.1 KB', '不保存正文', '不经过 Agent Message Switchboard', 'ms links resume']) {
    assert.ok(words.includes(part), part);
  }
  const daemon = draw(SNAPSHOT).byId.get('daemon')!;
  assert.match(daemon.textContent, /^msd 运行中 · v0\.4\.0 · 已运行 3 小时 15 分$/);
});

// Every card's pill goes by sessions online, installed by the ledger or by being seen at all;
// the connection row tells each harness's own story and nothing is drawn in warn colour.
function cardOf(doc: ReturnType<typeof fakeDocument>, label: string) {
  const card = all(doc).find(item => item.tagName === 'DIV' && item.getAttribute('class') === 'card'
    && elements(item).some(child => child.tagName === 'STRONG' && child.textContent === label))!;
  const pill = elements(card).find(child => child.tagName === 'SPAN' && (child.getAttribute('class') ?? '').startsWith('pill'))!;
  const terms = elements(card).filter(child => child.tagName === 'DT' || child.tagName === 'DD');
  const connection = terms[terms.findIndex(child => child.textContent === '连接') + 1].textContent;
  return { pill: pill.textContent, tone: pill.getAttribute('class'), dot: elements(pill).some(child => child.getAttribute('class') === 'dot'), connection };
}

test('cards and the overview go by sessions online for all three, installed by hand or not, attached or not', () => {
  const adapter = (attached: number) => ({ connection: { kind: 'adapter', attached } });
  const none = { online: 0, offline: 0 };
  const NO_SESSIONS = '已安装 · 没有在线会话';
  const cases: ReadonlyArray<readonly [string, Record<string, Record<string, unknown>>, string, Record<string, ReturnType<typeof cardOf>>]> = [
    ['one online, one attached, one closed', { 'claude-code': { online: 2 }, dsh: { ...none, ...adapter(1) }, codex: { ...none, ...adapter(0) } }, '1 / 3', {
      'Claude Code': { pill: '2 个会话在线', tone: 'pill ok', dot: true, connection: '不常驻连接，按会话登记' },
      DSH: { pill: NO_SESSIONS, tone: 'pill', dot: false, connection: 'DSH 插件已连上' },
      Codex: { pill: NO_SESSIONS, tone: 'pill', dot: false, connection: '没有打开的 Codex 会话（打开会话后几秒内连上）' } }],
    ['installed by hand, or not at all', { 'claude-code': { ...none, installed: false }, dsh: { ...none, ...adapter(1), installed: false },
      codex: { online: 1, ...adapter(1), installed: false } }, '1 / 3', {
      'Claude Code': { pill: '未安装', tone: 'pill', dot: false, connection: '没有用 ms 安装' },
      DSH: { pill: NO_SESSIONS, tone: 'pill', dot: false, connection: 'DSH 插件已连上' },
      Codex: { pill: '1 个会话在线', tone: 'pill ok', dot: true, connection: '1 个 Codex 会话进程已连上' } }],
    ['installed, nothing open', { 'claude-code': none, dsh: { ...none, ...adapter(0) }, codex: { ...none, ...adapter(0), installed: false } }, '0 / 3', {
      'Claude Code': { pill: NO_SESSIONS, tone: 'pill', dot: false, connection: '不常驻连接，按会话登记' },
      DSH: { pill: NO_SESSIONS, tone: 'pill', dot: false, connection: 'DSH 插件没连上（DSH 没打开？）' },
      Codex: { pill: '未安装', tone: 'pill', dot: false, connection: '没有用 ms 安装' } }],
    ['all online', { 'claude-code': { online: 1, installed: false }, dsh: { online: 2, ...adapter(3) }, codex: { online: 1, ...adapter(2) } }, '3 / 3', {
      'Claude Code': { pill: '1 个会话在线', tone: 'pill ok', dot: true, connection: '不常驻连接，按会话登记' },
      DSH: { pill: '2 个会话在线', tone: 'pill ok', dot: true, connection: 'DSH 插件已连上（3 个实例）' },
      Codex: { pill: '1 个会话在线', tone: 'pill ok', dot: true, connection: '2 个 Codex 会话进程已连上' } }],
  ];
  for (const [name, extras, count, cards] of cases) {
    const doc = draw({ ...SNAPSHOT, harnesses: SNAPSHOT.harnesses.map(item => ({ ...item, ...extras[item.harness] })) });
    for (const [label, expected] of Object.entries(cards)) assert.deepEqual(cardOf(doc, label), expected, `${name}: ${label}`);
    const stat = all(doc).find(item => item.tagName === 'DIV' && item.getAttribute('class') === 'stat'
      && item.textContent.endsWith('有会话在线的 Harness'))!;
    assert.equal(stat.textContent, `${count}有会话在线的 Harness`, name);
    assert.equal(all(doc).some(item => (item.getAttribute('class') ?? '').includes('warn')), false, name);
  }
});

test('down, error and empty pages each say what to do', () => {
  const down = text(draw({ installed: { 'claude-code': true, dsh: false, codex: true }, daemon: { state: 'down' } }));
  for (const part of ['msd 没有在运行', 'ms daemon start', '安装情况', 'Claude Code', '已用 ms 安装', '没有用 ms 安装']) {
    assert.ok(down.includes(part), part);
  }
  assert.ok(text(draw({ installed: null, daemon: { state: 'down' } })).includes('读不到安装账本'));
  const error = text(draw({ installed: null, daemon: { state: 'error', code: 'DAEMON_ERROR: RUNTIME_PIN_MISMATCH' } }));
  for (const part of ['读不到 msd 的状态', 'DAEMON_ERROR: RUNTIME_PIN_MISMATCH', 'ms daemon status']) assert.ok(error.includes(part), part);
  const empty = text(draw({ ...SNAPSHOT, sessions: [], links: { total: 0, paused: 0, suspended: 0, rows: [] }, messages: [] }));
  for (const part of ['还没有登记的会话', '/ms:register', '/ms-register', '$ms-register', 'ms config set auto-register on', '暂无']) {
    assert.ok(empty.includes(part), part);
  }
  assert.equal(text(draw(null)).includes('正在读取'), true);
});

test('grouping by project adds a harness column and the online filter drops offline rows', () => {
  const doc = draw(SNAPSHOT, { ...VIEW, groupBy: 'project', onlineOnly: true });
  const heads = all(doc).filter(item => item.tagName === 'TH').map(item => item.textContent);
  assert.ok(heads.includes('Harness'));
  assert.equal(text(doc).includes('x1-ccccc'), false);
  assert.ok(text(doc).includes('没有识别出项目'));
});

type Reply = { status: number; body?: unknown } | 'network';

function harnessed(replies: Reply[]) {
  const doc = fakeDocument(IDS);
  const pending: Array<() => void> = [];
  let calls = 0;
  let interval: { fn: () => void; ms: number } | null = null;
  const fetch = (url: string, init: Record<string, unknown>) => {
    calls += 1;
    assert.deepEqual([url, init], ['api/state', { cache: 'no-store', credentials: 'same-origin' }]);
    const reply = replies.shift();
    if (reply === undefined) return new Promise(resolve => pending.push(() => resolve({ status: 200, ok: true, json: async () => SNAPSHOT })));
    if (reply === 'network') return Promise.reject(new TypeError('Failed to fetch'));
    return Promise.resolve({ status: reply.status, ok: reply.status >= 200 && reply.status < 300, json: async () => reply.body });
  };
  const page = app.start({ document: doc, fetch, setInterval: (fn: () => void, ms: number) => { interval = { fn, ms }; }, now: () => NOW });
  return { doc, page, calls: () => calls, interval: () => interval, pending };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('refreshes every 3 seconds and keeps grouping, the online filter and open sections across redraws', async () => {
  const run = harnessed([{ status: 200, body: SNAPSHOT }, { status: 200, body: SNAPSHOT }]);
  await settle();
  assert.equal(run.interval()!.ms, 3000);
  assert.match(run.doc.byId.get('tick')!.textContent, /^每 3 秒刷新 · 上次 \d\d:\d\d:\d\d$/);
  find(run.doc, 'BUTTON', item => item.textContent === '按项目').fire('click');
  const box = find(run.doc, 'INPUT', item => item.getAttribute('type') === 'checkbox');
  box.checked = true; box.fire('change');
  const links = find(run.doc, 'DETAILS', item => item.getAttribute('data-k') === 'links');
  links.open = true; links.fire('toggle');
  run.interval()!.fn();
  await settle();
  assert.equal(run.calls(), 2);
  assert.deepEqual(run.page.state().view, { groupBy: 'project', onlineOnly: true, open: { links: true, messages: false } });
  assert.equal(find(run.doc, 'BUTTON', item => item.textContent === '按项目').getAttribute('aria-pressed'), 'true');
  assert.equal(find(run.doc, 'INPUT', item => item.getAttribute('type') === 'checkbox').checked, true);
  assert.equal(find(run.doc, 'DETAILS', item => item.getAttribute('data-k') === 'links').open, true);
  assert.equal(find(run.doc, 'DETAILS', item => item.getAttribute('data-k') === 'messages').open, false);
  const again = find(run.doc, 'DETAILS', item => item.getAttribute('data-k') === 'links');
  again.fire('toggle');
  assert.deepEqual(run.page.state().view.open, { links: true, messages: false });
});

test('a refresh still in flight makes the next tick skip instead of piling up requests', async () => {
  const run = harnessed([]);
  run.interval()!.fn(); run.interval()!.fn();
  assert.equal(run.calls(), 1);
  run.pending.shift()!();
  await settle();
  run.interval()!.fn();
  assert.equal(run.calls(), 2);
});

test('a dead server, a lost login and a bad status each raise a banner that clears on the next good refresh', async () => {
  const run = harnessed(['network', { status: 401 }, { status: 500 }, { status: 200, body: SNAPSHOT }]);
  const banner = () => run.doc.byId.get('banner')!;
  await settle();
  assert.deepEqual([banner().hidden, banner().textContent], [false, '本页的服务已停止（终端里的 ms ui 已经关闭）。重新运行 ms ui 打开新页面。']);
  await run.page.refresh();
  assert.deepEqual([banner().hidden, banner().textContent], [false, '本页的登录已失效，请重新运行 ms ui。']);
  await run.page.refresh();
  assert.deepEqual([banner().hidden, banner().textContent], [false, '状态页服务没有正常响应，稍后自动重试。']);
  await run.page.refresh();
  assert.deepEqual([banner().hidden, banner().textContent], [true, '']);
  assert.ok(texts(run.doc.byId.get('main')!).includes('Claude Code'));
});
