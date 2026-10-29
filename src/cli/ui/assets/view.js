// INPUT: The ms ui snapshot JSON (server.ts /ms-ui/api/state), the page's view choices and the local clock.
// OUTPUT: Pure page rules: overview, connection pills (by sessions online for all three), groups, names, labels and
//         time/size formatting; no DOM access.
// POS: Browser-side view model of the status page, shared by app.js and the offline tests.
export const REPLY_LABELS = Object.freeze({ direct: 'direct（只回答）', confirm: 'confirm（先问你）', act: 'act（可以动手）' });
export const REGISTER_COMMANDS = Object.freeze([['Claude Code', '/ms:register'], ['DSH', '/ms-register'], ['Codex', '$ms-register']]);
export const HARNESS_LABELS = Object.freeze({ 'claude-code': 'Claude Code', dsh: 'DSH', codex: 'Codex' });
export const BANNERS = Object.freeze({
  stopped: '本页的服务已停止（终端里的 ms ui 已经关闭）。重新运行 ms ui 打开新页面。',
  auth: '本页的登录已失效，请重新运行 ms ui。',
  failed: '状态页服务没有正常响应，稍后自动重试。',
});
const MESSAGE_STATES = Object.freeze({ dispatched: ['ok', '已投递'], pending: ['warn', '投递中'], 'delivery-unknown': ['warn', '结果未知'],
  undelivered: ['bad', '未投递'] });
const NO_PROJECT = '没有识别出项目';
const MINUTE = 60000;
const DAY = 24 * 60 * MINUTE;

export const harnessLabel = id => HARNESS_LABELS[id] ?? id;
export const shortId = id => id.slice(0, 8);
export const displayName = session => session.alias ?? session.title ?? '未命名会话';
export const endpointName = endpoint => endpoint.name ?? shortId(endpoint.sessionId);
export const withHarness = groupBy => groupBy === 'project';
export const hasOnline = harness => harness.online > 0;
export const installText = installed => (installed === null ? '读不到安装账本' : installed ? '已用 ms 安装' : '没有用 ms 安装');
export const messageState = state => MESSAGE_STATES[state] ?? ['', state];

export function overview(snapshot) {
  const sum = key => snapshot.harnesses.reduce((total, harness) => total + harness[key], 0);
  return { online: sum('online'), offline: sum('offline'), withOnline: snapshot.harnesses.filter(hasOnline).length,
    harnesses: snapshot.harnesses.length, links: snapshot.links.total, paused: snapshot.links.paused };
}

// How each harness reaches msd: Claude registers per session, the DSH plugin attaches while DSH runs, and each open Codex session's
// MCP process attaches on start.
function linkText(harness) {
  const attached = harness.connection.kind === 'adapter' ? harness.connection.attached : 0;
  if (harness.harness === 'dsh') {
    return attached === 0 ? 'DSH 插件没连上（DSH 没打开？）' : `DSH 插件已连上${attached > 1 ? `（${attached} 个实例）` : ''}`;
  }
  if (harness.harness === 'codex') {
    return attached === 0 ? '没有打开的 Codex 会话（打开会话后几秒内连上）' : `${attached} 个 Codex 会话进程已连上`;
  }
  return '不常驻连接，按会话登记';
}

// The pill goes by sessions online for all three. Being seen at all, a session online or an attached adapter, wins over the
// install ledger, so a harness installed by hand (see the user guide) reads as it really is.
export function connection(harness) {
  if (hasOnline(harness)) return { tone: 'ok', pill: `${harness.online} 个会话在线`, text: linkText(harness) };
  const attached = harness.connection.kind === 'adapter' && harness.connection.attached > 0;
  if (!attached && harness.installed === null) return { tone: '', pill: '安装情况未知', text: '读不到安装账本' };
  if (!attached && !harness.installed) return { tone: '', pill: '未安装', text: '没有用 ms 安装' };
  return { tone: '', pill: '已安装 · 没有在线会话', text: linkText(harness) };
}

export function autoText(harness, projects) {
  if (!harness.autoRegister) return '关';
  return `开（${projects.length ? projects.join('、') : '全部项目'}）`;
}

export function linkState(link) {
  if (link.paused) return ['warn', '已暂停（推送预算）'];
  return link.suspended ? ['', '挂起（有一端离线）'] : ['ok', '正常'];
}

const byOnlineThenNewest = (x, y) => Number(y.online) - Number(x.online) || Date.parse(y.at) - Date.parse(x.at);

function group(key, title, mono, all, onlineOnly) {
  const online = all.filter(session => session.online).length;
  const rows = (onlineOnly ? all.filter(session => session.online) : all).toSorted(byOnlineThenNewest);
  const empty = rows.length ? null : all.length ? '没有在线会话' : '没有登记的会话';
  return { key, title, mono, online, offline: all.length - online, rows, empty };
}

// Group counts always cover every session; the online filter only hides rows.
export function groups(snapshot, groupBy, onlineOnly) {
  const sessions = snapshot.sessions;
  if (groupBy === 'harness') {
    return snapshot.harnesses.map(harness => group(harness.harness, harness.label, false,
      sessions.filter(session => session.harness === harness.harness), onlineOnly));
  }
  const projects = [...new Set(sessions.map(session => session.project))]
    .toSorted((x, y) => (x === null) - (y === null) || (x ?? '').localeCompare(y ?? ''));
  return projects.map(project => group(project ?? '', project ?? NO_PROJECT, project !== null,
    sessions.filter(session => session.project === project), onlineOnly));
}

const pad = value => String(value).padStart(2, '0');

export function clock(time, seconds = false) {
  const date = new Date(time);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}${seconds ? `:${pad(date.getSeconds())}` : ''}`;
}

const startOfDay = time => { const date = new Date(time); return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime(); };

export function when(iso, now) {
  const time = Date.parse(iso);
  const minutes = Math.floor((now - time) / MINUTE);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const days = Math.round((startOfDay(now) - startOfDay(time)) / DAY);
  if (days === 0) return `今天 ${clock(time)}`;
  return days === 1 ? `昨天 ${clock(time)}` : `${days} 天前`;
}

export function uptime(iso, now) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / MINUTE));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} 小时 ${minutes % 60} 分` : `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
}

export function bytes(size) {
  if (size < 1024) return `${size} B`;
  return size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function daemonPill(snapshot, now) {
  if (snapshot === null) return ['', '正在读取…'];
  const { daemon } = snapshot;
  if (daemon.state === 'down') return ['bad', 'msd 未运行'];
  if (daemon.state === 'error') return ['warn', 'msd 读不到'];
  return ['ok', `msd 运行中 · v${daemon.version} · 已运行 ${uptime(daemon.startedAt, now)}`];
}
