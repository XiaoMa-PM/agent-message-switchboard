// INPUT: A control view name and the daemon's raw `result` value.
// OUTPUT: renderResult → aligned human text or pretty JSON after exact contract-shape validation (status and config views
//         carry the three harnesses' reply modes and act presets; status also the attached DSH and Codex adapter counts);
//         isResult → the same shape check alone, for the ms ui status page.
// POS: CLI output boundary; daemon strings are escaped so they cannot drive the terminal.
import { isActPreset } from '../protocol/peer-tiers.ts';
import { isReplyMode } from '../protocol/reply-mode-text.ts';
import { HARNESSES, type ControlView } from './args.ts';
import { CliError } from './errors.ts';

type Check = (value: unknown) => boolean;
type Row = Record<string, unknown>;

const text: Check = value => typeof value === 'string';
const nullableText: Check = value => value === null || typeof value === 'string';
const count: Check = value => Number.isSafeInteger(value) && (value as number) >= 0;
const positive: Check = value => Number.isSafeInteger(value) && (value as number) > 0;
const flag: Check = value => typeof value === 'boolean';
const harness: Check = value => (HARNESSES as readonly unknown[]).includes(value);
const absolutePath: Check = value => typeof value === 'string' && value.startsWith('/');
const literal = (expected: unknown): Check => value => value === expected;

function record(shape: Readonly<Record<string, Check>>): Check {
  const keys = Object.keys(shape).sort();
  return value => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const actual = Object.keys(value).sort();
    if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) return false;
    return keys.every(key => shape[key]((value as Row)[key]));
  };
}

const list = (item: Check): Check => value => Array.isArray(value) && value.every(item);
const perHarness = (item: Check) => record(Object.fromEntries(HARNESSES.map(name => [name, item])));
const endpoint = record({ harness, sessionId: text });
const contact = record({
  harness, sessionId: text, clientSurface: text, title: nullableText, cwd: nullableText,
  project: nullableText, alias: nullableText, online: flag, registeredAt: text, lastSeenAt: text,
});

const SHAPES: Readonly<Record<ControlView, Check>> = Object.freeze({
  status: record({
    version: text, startedAt: text, sessions: perHarness(record({ online: count, offline: count })),
    links: record({ total: count, suspended: count, paused: count }), autoRegister: perHarness(flag),
    autoRegisterProjects: list(absolutePath), replyMode: perHarness(isReplyMode), actPreset: perHarness(isActPreset),
    adapters: record({ dsh: count, codex: count }),
  }),
  sessions: list(contact),
  projects: list(record({ project: text, sessions: perHarness(record({ online: count, offline: count })) })),
  alias: contact,
  'link-resume': record({ linkId: text, paused: literal(false) }),
  links: list(record({ linkId: text, a: endpoint, b: endpoint, messages: count, paused: flag, suspended: flag })),
  messages: list(record({ messageId: text, linkId: text, from: endpoint, to: endpoint, sentAt: text, state: text, bytes: count })),
  config: record({
    autoRegister: perHarness(flag), autoRegisterProjects: list(absolutePath), replyMode: perHarness(isReplyMode),
    actPreset: perHarness(isActPreset), linkBudget: record({ windowSeconds: positive, maxPushes: positive }),
  }),
});

function safe(value: unknown): string {
  if (value === null) return '-';
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function address(value: unknown): string {
  const { harness: name, sessionId } = value as Row;
  return `${safe(name)}:${safe(sessionId)}`;
}

function table(header: readonly string[], rows: readonly string[][]): string {
  if (rows.length === 0) return '(none)';
  const widths = header.map((title, index) => Math.max(title.length, ...rows.map(row => row[index].length)));
  const line = (cells: readonly string[]) => cells.map((cell, index) =>
    index === cells.length - 1 ? cell : cell.padEnd(widths[index])).join('  ');
  return [line(header), ...rows.map(line)].join('\n');
}

function onOff(value: unknown): string {
  const states = value as Row;
  return HARNESSES.map(name => `${name} ${states[name] ? 'on' : 'off'}`).join(', ');
}

function perHarnessLine(label: string, value: unknown): string {
  const values = value as Row;
  return `${label}: ${HARNESSES.map(name => `${name} ${safe(values[name])}`).join(', ')}`;
}

function projectsLine(value: unknown): string {
  const projects = value as string[];
  return `auto-register projects: ${projects.length ? projects.map(safe).join(', ') : '(any)'}`;
}

function renderStatus(value: Row): string {
  const sessions = value.sessions as Record<string, Row>;
  const links = value.links as Row;
  return [
    `msd ${safe(value.version)} (started ${safe(value.startedAt)})`,
    `sessions: ${HARNESSES.map(name => `${name} ${safe(sessions[name].online)} online / ${safe(sessions[name].offline)} offline`).join(', ')}`,
    `links: ${safe(links.total)} (${safe(links.suspended)} suspended, ${safe(links.paused)} paused)`,
    `auto-register: ${onOff(value.autoRegister)}`,
    projectsLine(value.autoRegisterProjects),
    perHarnessLine('reply-mode', value.replyMode),
    perHarnessLine('act-preset', value.actPreset),
    `adapters: dsh ${safe((value.adapters as Row).dsh)} attached, codex ${safe((value.adapters as Row).codex)} attached`,
  ].join('\n');
}

function renderConfig(value: Row): string {
  const budget = value.linkBudget as Row;
  return [
    `auto-register: ${onOff(value.autoRegister)}`,
    projectsLine(value.autoRegisterProjects),
    perHarnessLine('reply-mode', value.replyMode),
    perHarnessLine('act-preset', value.actPreset),
    `link-budget: ${safe(budget.maxPushes)} pushes per ${safe(budget.windowSeconds)} s`,
  ].join('\n');
}

function renderSingle(view: 'alias' | 'link-resume', value: Row): string {
  if (view === 'alias') return value.alias === null ? `alias ${address(value)} cleared` : `alias ${address(value)} = ${safe(value.alias)}`;
  return `link ${safe(value.linkId)} resumed`;
}

function renderRows(view: 'sessions' | 'projects' | 'links' | 'messages', rows: readonly Row[]): string {
  if (view === 'sessions') {
    return table(['HARNESS', 'SURFACE', 'SESSION', 'ALIAS', 'TITLE', 'PROJECT', 'STATE', 'LAST SEEN'], rows.map(row =>
      [...[row.harness, row.clientSurface, row.sessionId, row.alias, row.title, row.project].map(safe),
        row.online ? 'online' : 'offline', safe(row.lastSeenAt)]));
  }
  if (view === 'projects') {
    return table(['PROJECT', ...HARNESSES.map(name => `${name.toUpperCase()} ON/OFF`)], rows.map(row => [safe(row.project),
      ...HARNESSES.map(name => { const counts = (row.sessions as Record<string, Row>)[name]; return `${safe(counts.online)}/${safe(counts.offline)}`; })]));
  }
  if (view === 'links') {
    return table(['LINK', 'A', 'B', 'MESSAGES', 'PAUSED', 'SUSPENDED'], rows.map(row =>
      [safe(row.linkId), address(row.a), address(row.b), safe(row.messages), row.paused ? 'yes' : 'no', row.suspended ? 'yes' : 'no']));
  }
  return table(['MESSAGE', 'LINK', 'FROM', 'TO', 'SENT', 'STATE', 'BYTES'], rows.map(row =>
    [safe(row.messageId), safe(row.linkId), address(row.from), address(row.to), safe(row.sentAt), safe(row.state), safe(row.bytes)]));
}

export function isResult(view: ControlView, value: unknown): boolean {
  return SHAPES[view](value);
}

export function renderResult(view: ControlView, value: unknown, json: boolean): string {
  if (!isResult(view, value)) throw new CliError('DAEMON_PROTOCOL_INVALID');
  if (json) return JSON.stringify(value, null, 2);
  if (view === 'status') return renderStatus(value as Row);
  if (view === 'config') return renderConfig(value as Row);
  if (view === 'alias' || view === 'link-resume') return renderSingle(view, value as Row);
  return renderRows(view, value as Row[]);
}
