// INPUT: A document (the browser's, or a fake in tests), fetch, setInterval and a clock; snapshots from api/state; view.js rules.
// OUTPUT: render (draws the header pill, refresh tick, banner and main sections) and start (refresh every 3 seconds, skip while one
//         is in flight, keep the view choices across redraws).
// POS: Browser side of the status page; every value from the snapshot becomes a text node, never markup.
import {
  autoText, BANNERS, bytes, clock, connection, daemonPill, displayName, endpointName, groups, harnessLabel, installText, linkState,
  messageState, overview, REGISTER_COMMANDS, REPLY_LABELS, shortId, when, withHarness,
} from './view.js';

const REFRESH_MS = 3000;
const ATTRIBUTES = new Set(['class', 'title', 'aria-pressed', 'type', 'data-k']);

// Children are appended as nodes or plain strings (which the DOM turns into text nodes); attributes come from a fixed set.
function el(doc, tag, attributes, ...children) {
  const node = doc.createElement(tag);
  for (const [name, value] of Object.entries(attributes ?? {})) {
    if (!ATTRIBUTES.has(name)) throw new Error(`attribute not allowed: ${name}`);
    if (value !== null && value !== undefined) node.setAttribute(name, String(value));
  }
  node.append(...children.flat().filter(child => child !== null && child !== undefined && child !== false));
  return node;
}

const pill = (doc, tone, text, dot = true) => el(doc, 'span', { class: tone ? `pill ${tone}` : 'pill' },
  dot ? el(doc, 'span', { class: 'dot' }) : null, text);
const code = (doc, text) => el(doc, 'code', null, text);

function stats(doc, snapshot) {
  const numbers = overview(snapshot);
  const stat = (value, label) => el(doc, 'div', { class: 'stat' }, el(doc, 'div', { class: 'n' }, String(value)),
    el(doc, 'div', { class: 'l' }, label));
  return el(doc, 'div', { class: 'stats' }, stat(numbers.online, '在线会话'), stat(numbers.offline, '离线会话'),
    stat(`${numbers.withOnline} / ${numbers.harnesses}`, '有会话在线的 Harness'),
    stat(numbers.links, numbers.paused ? `线路（${numbers.paused} 条暂停）` : '线路'));
}

function cards(doc, snapshot) {
  const card = harness => {
    const state = connection(harness);
    const row = (term, value) => [el(doc, 'dt', null, term), el(doc, 'dd', null, value)];
    return el(doc, 'div', { class: 'card' },
      el(doc, 'div', { class: 'card-head' }, el(doc, 'strong', null, harness.label), pill(doc, state.tone, state.pill, state.tone !== '')),
      el(doc, 'dl', null, row('安装', installText(harness.installed)), row('连接', state.text),
        row('会话', `${harness.online} 在线 / ${harness.offline} 离线`), row('回复档位', REPLY_LABELS[harness.replyMode] ?? harness.replyMode),
        row('act 预设', harness.actPresetLabel), row('自动登记', autoText(harness, snapshot.autoRegisterProjects))));
  };
  return el(doc, 'section', null, el(doc, 'h2', null, 'Harness'), el(doc, 'div', { class: 'cards' }, snapshot.harnesses.map(card)));
}

function sessionRow(doc, session, now, harnessColumn) {
  const name = session.alias !== null
    ? [el(doc, 'b', null, session.alias), session.title === null ? null : el(doc, 'span', { class: 't' }, session.title)]
    : session.title ?? el(doc, 'span', { class: 'muted' }, displayName(session));
  const state = session.online ? el(doc, 'span', { class: 'state on' }, el(doc, 'span', { class: 'dot' }), '在线')
    : el(doc, 'span', { class: 'state off' }, el(doc, 'span', { class: 'dot' }), '离线');
  return el(doc, 'tr', { class: session.online ? null : 'is-off' }, el(doc, 'td', null, state), el(doc, 'td', { class: 'name' }, name),
    harnessColumn ? el(doc, 'td', null, harnessLabel(session.harness)) : null,
    el(doc, 'td', null, el(doc, 'span', { class: 'tag' }, session.surface === 'desktop' ? '桌面' : 'CLI')),
    el(doc, 'td', { class: 'mono' }, session.project ?? '-'),
    el(doc, 'td', null, `${session.online ? '上线于' : '下线于'} ${when(session.at, now)}`),
    el(doc, 'td', { class: 'mono muted', title: session.sessionId }, shortId(session.sessionId)));
}

function table(doc, heads, rows) {
  return el(doc, 'div', { class: 'scroll' }, el(doc, 'table', null,
    el(doc, 'thead', null, el(doc, 'tr', null, heads.map(head => el(doc, 'th', null, head)))),
    el(doc, 'tbody', null, rows.length ? rows : el(doc, 'tr', null, el(doc, 'td', { class: 'muted' }, '暂无')))));
}

function segment(doc, view, actions) {
  const button = (value, label) => {
    const node = el(doc, 'button', { type: 'button', 'aria-pressed': String(view.groupBy === value) }, label);
    node.addEventListener('click', () => actions.choose({ groupBy: value }));
    return node;
  };
  const box = el(doc, 'input', { type: 'checkbox' });
  box.checked = view.onlineOnly;
  box.addEventListener('change', () => actions.choose({ onlineOnly: box.checked }));
  return el(doc, 'div', { class: 'controls' }, el(doc, 'span', { class: 'seg' }, button('harness', '按 Harness'), button('project', '按项目')),
    el(doc, 'label', { class: 'chk' }, box, '只看在线'));
}

function emptySessions(doc) {
  return el(doc, 'div', { class: 'empty' }, el(doc, 'h3', null, '还没有登记的会话'),
    el(doc, 'p', null, '在要互通的会话里输入登记命令，登记后几秒内会出现在这里：'),
    el(doc, 'div', { class: 'scroll' }, el(doc, 'table', null, el(doc, 'tbody', null,
      REGISTER_COMMANDS.map(([label, command]) => el(doc, 'tr', null, el(doc, 'td', null, label), el(doc, 'td', null, code(doc, command))))))),
    el(doc, 'p', null, '也可以用 ', code(doc, 'ms config set auto-register on'), ' 打开自动登记。'));
}

function sessions(doc, snapshot, view, now, actions) {
  const toolbar = el(doc, 'div', { class: 'toolbar' }, el(doc, 'h2', null, '会话'), segment(doc, view, actions));
  if (snapshot.sessions.length === 0) return el(doc, 'section', null, toolbar, emptySessions(doc));
  const heads = ['状态', '名称', ...(withHarness(view.groupBy) ? ['Harness'] : []), '入口', '项目', '时间', '会话编号'];
  const blocks = groups(snapshot, view.groupBy, view.onlineOnly).map(item => el(doc, 'div', { class: 'group' },
    el(doc, 'div', { class: 'group-head' }, el(doc, 'strong', { class: item.mono ? 'mono' : null }, item.title),
      el(doc, 'span', { class: 'muted' }, `${item.online} 在线 / ${item.offline} 离线`)),
    item.empty === null ? table(doc, heads, item.rows.map(row => sessionRow(doc, row, now, withHarness(view.groupBy))))
      : el(doc, 'div', { class: 'muted pad' }, item.empty)));
  return el(doc, 'section', null, toolbar, blocks);
}

function folded(doc, key, view, actions, title, count, body, note) {
  const node = el(doc, 'details', { 'data-k': key },
    el(doc, 'summary', null, el(doc, 'span', null, title), el(doc, 'span', { class: 'muted' }, count)), body, el(doc, 'div', { class: 'note' }, note));
  node.open = view.open[key];
  // Setting open fires toggle too; only a real change is remembered, and without a redraw.
  node.addEventListener('toggle', () => { if (node.open !== actions.current().open[key]) actions.keep({ open: { ...actions.current().open, [key]: node.open } }); });
  return node;
}

function activity(doc, snapshot, view, now, actions) {
  const end = endpoint => [endpointName(endpoint), el(doc, 'span', { class: 'muted' }, ` · ${harnessLabel(endpoint.harness)}`)];
  const links = snapshot.links.rows.map(link => {
    const [tone, text] = linkState(link);
    return el(doc, 'tr', null, el(doc, 'td', null, end(link.a)), el(doc, 'td', { class: 'muted' }, '⇄'), el(doc, 'td', null, end(link.b)),
      el(doc, 'td', null, `${link.messages} 封`), el(doc, 'td', null, pill(doc, tone, text, false)));
  });
  const messages = snapshot.messages.map(message => {
    const [tone, text] = messageState(message.state);
    return el(doc, 'tr', null, el(doc, 'td', null, when(message.sentAt, now)), el(doc, 'td', null, end(message.from)),
      el(doc, 'td', { class: 'muted' }, '→'), el(doc, 'td', null, end(message.to)), el(doc, 'td', null, bytes(message.bytes)),
      el(doc, 'td', null, pill(doc, tone, text, false)));
  });
  return el(doc, 'section', null, el(doc, 'h2', null, '线路与消息'),
    folded(doc, 'links', view, actions, '线路', `${snapshot.links.rows.length} 条`, table(doc, ['一端', '', '另一端', '消息', '状态'], links),
      ['已暂停的线路，先用 ', code(doc, 'ms links'), ' 查到线路编号，再运行 ', code(doc, 'ms links resume <线路编号>'),
        ' 恢复。同一个 Harness 里的会话互发走各家自己的能力，不经过 Agent Message Switchboard，这里看不到。']),
    folded(doc, 'messages', view, actions, '最近消息', `${snapshot.messages.length} 封`,
      table(doc, ['时间', '发信', '', '收信', '大小', '状态'], messages), 'msd 只记录谁发给谁、什么时候、多大和投递结果，不保存正文。'));
}

function down(doc, snapshot) {
  const installed = snapshot.installed;
  return el(doc, 'div', { class: 'empty' }, el(doc, 'h3', null, 'msd 没有在运行'),
    el(doc, 'p', null, '会话之间暂时收发不了消息。在终端运行 ', code(doc, 'ms daemon start'), '，本页会在几秒内自动恢复。'),
    el(doc, 'p', null, '安装情况：'),
    el(doc, 'div', { class: 'scroll' }, el(doc, 'table', null, el(doc, 'tbody', null,
      ['claude-code', 'dsh', 'codex'].map(id => el(doc, 'tr', null, el(doc, 'td', null, harnessLabel(id)),
        el(doc, 'td', null, installText(installed === null ? null : installed[id]))))))));
}

function unreadable(doc, snapshot) {
  return el(doc, 'div', { class: 'empty' }, el(doc, 'h3', null, '读不到 msd 的状态'),
    el(doc, 'p', null, 'msd 返回了 ', code(doc, snapshot.daemon.code), '。本页会自动重试；也可以在终端运行 ', code(doc, 'ms daemon status'), ' 看看。'));
}

function content(doc, state, now, actions) {
  const { snapshot, view } = state;
  if (snapshot === null) return [el(doc, 'p', { class: 'muted' }, '正在读取…')];
  if (snapshot.daemon.state === 'down') return [down(doc, snapshot)];
  if (snapshot.daemon.state === 'error') return [unreadable(doc, snapshot)];
  return [stats(doc, snapshot), cards(doc, snapshot), sessions(doc, snapshot, view, now, actions), activity(doc, snapshot, view, now, actions)];
}

export function render(doc, state, now, actions) {
  const [tone, text] = daemonPill(state.snapshot, now);
  doc.getElementById('daemon').replaceChildren(pill(doc, tone, text, tone !== ''));
  doc.getElementById('tick').textContent = state.refreshedAt === null ? '每 3 秒刷新' : `每 3 秒刷新 · 上次 ${clock(state.refreshedAt, true)}`;
  const banner = doc.getElementById('banner');
  banner.replaceChildren(...(state.banner === null ? [] : [BANNERS[state.banner]]));
  banner.hidden = state.banner === null;
  doc.getElementById('main').replaceChildren(...content(doc, state, now, actions));
}

export function start(env) {
  let state = Object.freeze({ snapshot: null, banner: null, refreshedAt: null,
    view: Object.freeze({ groupBy: 'harness', onlineOnly: false, open: Object.freeze({ links: false, messages: false }) }) });
  let busy = false;
  const remember = change => { state = Object.freeze({ ...state, view: Object.freeze({ ...state.view, ...change }) }); };
  const actions = Object.freeze({
    choose: change => { remember(change); draw(); },
    keep: remember,
    current: () => state.view,
  });
  const draw = () => render(env.document, state, env.now(), actions);
  const outcome = async () => {
    try {
      const response = await env.fetch('api/state', { cache: 'no-store', credentials: 'same-origin' });
      if (response.status === 401) return { banner: 'auth' };
      if (!response.ok) return { banner: 'failed' };
      return { snapshot: await response.json(), banner: null, refreshedAt: env.now() };
    } catch { return { banner: 'stopped' }; }
  };
  const refresh = async () => {
    if (busy) return;
    busy = true;
    const change = await outcome();
    busy = false;
    state = Object.freeze({ ...state, ...change });
    draw();
  };
  void refresh();
  env.setInterval(() => { void refresh(); }, REFRESH_MS);
  return Object.freeze({ refresh, state: () => state });
}
