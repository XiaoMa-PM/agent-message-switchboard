// INPUT: A control-API caller (callControl on the msd socket), the install manifest (loadManifest), HOME, format.ts's isResult
//        shapes, and the shared HARNESS_NAMES and PRESET_NAMES labels.
// OUTPUT: READ_ONLY_METHODS and readOnly (refuses anything else before it reaches msd), installedHarnesses (the install-ledger
//         rule), readSnapshot → the status page's state JSON (running, down or error).
// POS: ms ui data boundary; four fixed reads per refresh, nothing cached, nothing written.
import { HARNESSES, type Harness } from '../args.ts';
import { CliError } from '../errors.ts';
import { isResult } from '../format.ts';
import { type MsPaths } from '../paths.ts';
import { loadManifest } from '../uninstall.ts';
import { HARNESS_NAMES } from '../../protocol/inbound-header.ts';
import { PRESET_NAMES } from '../../protocol/act-text.ts';
import { type ActPreset } from '../../protocol/peer-tiers.ts';

export const READ_ONLY_METHODS = Object.freeze(['status', 'sessions.list', 'links.list', 'messages.list'] as const);
type ReadOnlyMethod = typeof READ_ONLY_METHODS[number];
export type Control = (method: string, params: Record<string, unknown>) => Promise<unknown>;
export type Installed = Readonly<Record<Harness, boolean>> | null;
export type SnapshotDeps = Readonly<{ control: Control; installed: () => Promise<Installed>; home: string }>;

type Counts = Readonly<{ online: number; offline: number }>;
type Ref = Readonly<{ harness: Harness; sessionId: string }>;
type Status = Readonly<{ version: string; startedAt: string; sessions: Record<Harness, Counts>;
  links: Readonly<{ total: number; suspended: number; paused: number }>; autoRegister: Record<Harness, boolean>;
  autoRegisterProjects: string[]; replyMode: Record<Harness, string>; actPreset: Record<Harness, ActPreset>;
  adapters: Readonly<{ dsh: number; codex: number }> }>;
type Contact = Ref & Readonly<{ clientSurface: string; title: string | null; project: string | null; alias: string | null;
  online: boolean; lastSeenAt: string }>;
type Link = Readonly<{ linkId: string; a: Ref; b: Ref; messages: number; paused: boolean; suspended: boolean }>;
type Message = Readonly<{ messageId: string; from: Ref; to: Ref; sentAt: string; state: string; bytes: number }>;
type Raw = Readonly<{ status: Status; sessions: Contact[]; links: Link[]; messages: Message[] }>;

const VIEWS = Object.freeze({ status: 'status', 'sessions.list': 'sessions', 'links.list': 'links', 'messages.list': 'messages' } as const);
const MESSAGE_LIMIT = 20;

export function readOnly(control: Control): Control {
  return async (method, params) => {
    if (!(READ_ONLY_METHODS as readonly string[]).includes(method)) throw new CliError('UI_METHOD_REFUSED');
    return control(method, params);
  };
}

async function read(call: Control, method: ReadOnlyMethod, params: Record<string, unknown>): Promise<unknown> {
  const value = await call(method, params);
  if (!isResult(VIEWS[method], value)) throw new CliError('DAEMON_PROTOCOL_INVALID');
  return value;
}

// Same rule as ms install --harness: a harness is installed by ms once a ledger record carries its mark.
export async function installedHarnesses(paths: MsPaths): Promise<Installed> {
  const of = (marked: (harness: Harness) => boolean) => Object.freeze(Object.fromEntries(HARNESSES.map(name => [name, marked(name)])) as
    Record<Harness, boolean>);
  try {
    const manifest = await loadManifest(paths);
    return of(name => manifest.records.some(record => record.harness === name));
  } catch (error) {
    if (error instanceof CliError && error.code === 'NOT_INSTALLED') return of(() => false);
    return null;
  }
}

const filled = (value: string | null) => (value === null || value.trim() === '' ? null : value);

function shorten(home: string) {
  return (path: string | null) => {
    if (path === null || path !== home && !path.startsWith(`${home}/`)) return path;
    return `~${path.slice(home.length)}`;
  };
}

function toSnapshot(raw: Raw, installed: Installed, home: string) {
  const { status } = raw;
  const short = shorten(home);
  const names = new Map(raw.sessions.map(row => [`${row.harness}\0${row.sessionId}`, filled(row.alias) ?? filled(row.title)]));
  const endpoint = (ref: Ref) => Object.freeze({ harness: ref.harness, sessionId: ref.sessionId,
    name: names.get(`${ref.harness}\0${ref.sessionId}`) ?? null });
  return Object.freeze({
    installed,
    daemon: Object.freeze({ state: 'running', version: status.version, startedAt: status.startedAt }),
    harnesses: HARNESSES.map(harness => Object.freeze({ harness, label: HARNESS_NAMES[harness], installed: installed?.[harness] ?? null,
      online: status.sessions[harness].online, offline: status.sessions[harness].offline,
      connection: harness === 'claude-code' ? { kind: 'sessions' } : { kind: 'adapter', attached: status.adapters[harness] },
      replyMode: status.replyMode[harness], actPreset: status.actPreset[harness], actPresetLabel: PRESET_NAMES[status.actPreset[harness]],
      autoRegister: status.autoRegister[harness] })),
    autoRegisterProjects: status.autoRegisterProjects.map(short),
    links: Object.freeze({ total: status.links.total, paused: status.links.paused, suspended: status.links.suspended,
      rows: raw.links.map(link => Object.freeze({ linkId: link.linkId, a: endpoint(link.a), b: endpoint(link.b), messages: link.messages,
        paused: link.paused, suspended: link.suspended })) }),
    sessions: raw.sessions.map(row => Object.freeze({ harness: row.harness, sessionId: row.sessionId, alias: filled(row.alias),
      title: filled(row.title), surface: row.clientSurface, project: short(row.project), online: row.online, at: row.lastSeenAt })),
    messages: raw.messages.map(message => Object.freeze({ messageId: message.messageId, sentAt: message.sentAt, from: endpoint(message.from),
      to: endpoint(message.to), bytes: message.bytes, state: message.state })),
  });
}

// Any failed read turns the whole snapshot into down or error, so the page never shows half of one refresh.
export async function readSnapshot(deps: SnapshotDeps) {
  const call = readOnly(deps.control);
  const installed = await deps.installed();
  try {
    const [status, sessions, links, messages] = await Promise.all([read(call, 'status', {}), read(call, 'sessions.list', {}),
      read(call, 'links.list', {}), read(call, 'messages.list', { limit: MESSAGE_LIMIT })]);
    return toSnapshot({ status, sessions, links, messages } as Raw, installed, deps.home);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    if (error.code === 'DAEMON_UNAVAILABLE') return Object.freeze({ installed, daemon: Object.freeze({ state: 'down' }) });
    const code = error.detail === undefined ? error.code : `${error.code}: ${error.detail}`;
    return Object.freeze({ installed, daemon: Object.freeze({ state: 'error', code }) });
  }
}
