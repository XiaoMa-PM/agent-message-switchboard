// INPUT: Raw ms argv tokens after the executable name, the caller's working directory (for --project paths) and the
//        protocol's isReplyMode and isActPreset (reply-mode and act-preset values).
// OUTPUT: parseArgs → frozen command union with exact control-API method/params (and `ui`; `upgrade`); USAGE_INVALID on
//         any ambiguity.
// POS: Sole CLI input boundary; no IO, defaults only where the command surface defines them.
import { resolve } from 'node:path';
import { isActPreset } from '../protocol/peer-tiers.ts';
import { isReplyMode } from '../protocol/reply-mode-text.ts';

export type Harness = 'claude-code' | 'dsh' | 'codex';
export type ControlView = 'status' | 'sessions' | 'projects' | 'alias' | 'links' | 'link-resume' | 'messages' | 'config';
export type ControlMethod = 'status' | 'sessions.list' | 'projects.list' | 'sessions.alias' | 'links.list' | 'links.resume'
  | 'messages.list' | 'config.get' | 'config.set';
export type ControlCommand = Readonly<{
  kind: 'control'; view: ControlView; method: ControlMethod; params: Record<string, unknown>; json: boolean;
}>;
export type CliCommand =
  | Readonly<{ kind: 'help' }>
  | Readonly<{ kind: 'install'; dryRun: boolean; harness: Harness | null }>
  | Readonly<{ kind: 'repin'; dryRun: boolean }>
  | Readonly<{ kind: 'uninstall'; dryRun: boolean; keepData: boolean; harness: Harness | null }>
  | Readonly<{ kind: 'daemon'; action: 'start' | 'stop' | 'status' }>
  | Readonly<{ kind: 'ui' }>
  | Readonly<{ kind: 'upgrade'; dryRun: boolean }>
  | ControlCommand;

export const HARNESSES: readonly Harness[] = Object.freeze(['claude-code', 'dsh', 'codex']);
const MAX_MESSAGE_LIMIT = 200;

type FlagSpec = Readonly<Record<string, 'value' | 'switch'>>;
type Parsed = Readonly<{ flags: Readonly<Record<string, string | true>>; positionals: readonly string[] }>;

function usage(): never { throw new Error('USAGE_INVALID'); }

function tokens(list: readonly string[], spec: FlagSpec, positionals = 0): Parsed {
  const flags: Record<string, string | true> = {};
  const values: string[] = [];
  for (let index = 0; index < list.length; index += 1) {
    const name = list[index];
    if (!name.startsWith('--')) { if (name === '') usage(); values.push(name); continue; }
    const kind = Object.hasOwn(spec, name) ? spec[name] : undefined;
    if (!kind || Object.hasOwn(flags, name)) usage();
    if (kind === 'switch') { flags[name] = true; continue; }
    const value = list[index + 1];
    if (value === undefined || value === '' || value.startsWith('--')) usage();
    flags[name] = value;
    index += 1;
  }
  if (values.length !== positionals) usage();
  return Object.freeze({ flags: Object.freeze(flags), positionals: Object.freeze(values) });
}

function positiveInteger(text: string | true | undefined, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof text !== 'string' || !/^[1-9][0-9]*$/.test(text)) usage();
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value > max) usage();
  return value;
}

function harness(text: string | true | undefined): Harness {
  if (typeof text !== 'string' || !(HARNESSES as readonly string[]).includes(text)) usage();
  return text as Harness;
}

function control(view: ControlView, method: ControlMethod, params: Record<string, unknown>, parsed: Parsed): ControlCommand {
  return Object.freeze({ kind: 'control', view, method, params: Object.freeze(params), json: parsed.flags['--json'] === true });
}

function sessions(rest: readonly string[], cwd: string): ControlCommand {
  const parsed = tokens(rest, { '--harness': 'value', '--project': 'value', '--json': 'switch' });
  const params: Record<string, unknown> = {};
  if (parsed.flags['--harness'] !== undefined) params.harness = harness(parsed.flags['--harness']);
  const project = parsed.flags['--project'] as string | undefined;
  if (project !== undefined) params.project = project.includes('/') || project === '.' || project === '..' ? resolve(cwd, project) : project;
  return control('sessions', 'sessions.list', params, parsed);
}

function messages(rest: readonly string[]): ControlCommand {
  const parsed = tokens(rest, { '--link': 'value', '--limit': 'value', '--json': 'switch' });
  const params: Record<string, unknown> = {};
  if (parsed.flags['--link'] !== undefined) params.linkId = parsed.flags['--link'];
  if (parsed.flags['--limit'] !== undefined) params.limit = positiveInteger(parsed.flags['--limit'], MAX_MESSAGE_LIMIT);
  return control('messages', 'messages.list', params, parsed);
}

function links(rest: readonly string[]): ControlCommand {
  if (rest[0] !== 'resume') return control('links', 'links.list', {}, tokens(rest, { '--json': 'switch' }));
  const parsed = tokens(rest.slice(1), { '--json': 'switch' }, 1);
  return control('link-resume', 'links.resume', { linkId: parsed.positionals[0] }, parsed);
}

function alias(rest: readonly string[]): ControlCommand {
  const clear = rest.includes('--clear');
  const parsed = tokens(rest, { '--json': 'switch', '--clear': 'switch' }, clear ? 2 : 3);
  const [name, sessionId, label] = parsed.positionals;
  return control('alias', 'sessions.alias', { harness: harness(name), sessionId, alias: clear ? null : label }, parsed);
}

function autoRegister(rest: readonly string[], cwd: string): ControlCommand {
  const parsed = tokens(rest, { '--harness': 'value', '--project': 'value', '--json': 'switch' }, 1);
  const state = parsed.positionals[0];
  if (state !== 'on' && state !== 'off') usage();
  const { '--harness': only, '--project': project } = parsed.flags;
  if (only !== undefined && project !== undefined) usage();
  if (project !== undefined) {
    const path = resolve(cwd, project as string);
    return control('config', 'config.set', { autoRegisterProjects: state === 'on' ? { add: [path] } : { remove: [path] } }, parsed);
  }
  const targets = only === undefined ? HARNESSES : [harness(only)];
  return control('config', 'config.set', { autoRegister: Object.fromEntries(targets.map(name => [name, state === 'on'])) }, parsed);
}

// reply-mode and act-preset: one value for one harness, or for all three without --harness (like auto-register).
function perHarness(rest: readonly string[], key: 'replyMode' | 'actPreset', valid: (value: unknown) => boolean): ControlCommand {
  const parsed = tokens(rest, { '--harness': 'value', '--json': 'switch' }, 1);
  const value = parsed.positionals[0];
  if (!valid(value)) usage();
  const only = parsed.flags['--harness'];
  const targets = only === undefined ? HARNESSES : [harness(only)];
  return control('config', 'config.set', { [key]: Object.fromEntries(targets.map(name => [name, value])) }, parsed);
}

function config(rest: readonly string[], cwd: string): ControlCommand {
  const [action, key, ...tail] = rest;
  if (action === 'get') return control('config', 'config.get', {}, tokens(rest.slice(1), { '--json': 'switch' }));
  if (action !== 'set') return usage();
  if (key === 'auto-register') return autoRegister(tail, cwd);
  if (key === 'reply-mode') return perHarness(tail, 'replyMode', isReplyMode);
  if (key === 'act-preset') return perHarness(tail, 'actPreset', isActPreset);
  if (key !== 'link-budget') return usage();
  const parsed = tokens(tail, { '--window-seconds': 'value', '--max-pushes': 'value', '--json': 'switch' });
  const linkBudget = {
    windowSeconds: positiveInteger(parsed.flags['--window-seconds']),
    maxPushes: positiveInteger(parsed.flags['--max-pushes']),
  };
  return control('config', 'config.set', { linkBudget }, parsed);
}

export function parseArgs(argv: readonly string[], cwd: string): CliCommand {
  const [command, ...rest] = argv;
  if (command === undefined || ((command === 'help' || command === '--help') && rest.length === 0)) {
    return Object.freeze({ kind: 'help' });
  }
  if (command === 'repin') return Object.freeze({ kind: command, dryRun: tokens(rest, { '--dry-run': 'switch' }).flags['--dry-run'] === true });
  if (command === 'install') {
    const { flags } = tokens(rest, { '--dry-run': 'switch', '--harness': 'value' });
    const only = flags['--harness'] === undefined ? null : harness(flags['--harness']);
    return Object.freeze({ kind: 'install', dryRun: flags['--dry-run'] === true, harness: only });
  }
  if (command === 'uninstall') {
    const { flags } = tokens(rest, { '--dry-run': 'switch', '--keep-data': 'switch', '--harness': 'value' });
    const only = flags['--harness'] === undefined ? null : harness(flags['--harness']);
    if (only !== null && flags['--keep-data'] === true) usage();
    return Object.freeze({ kind: 'uninstall', dryRun: flags['--dry-run'] === true, keepData: flags['--keep-data'] === true, harness: only });
  }
  if (command === 'daemon') {
    const [action, ...tail] = rest;
    if ((action !== 'start' && action !== 'stop' && action !== 'status') || tail.length) usage();
    return Object.freeze({ kind: 'daemon', action });
  }
  if (command === 'ui') { tokens(rest, {}); return Object.freeze({ kind: 'ui' }); }
  if (command === 'upgrade') return Object.freeze({ kind: command, dryRun: tokens(rest, { '--dry-run': 'switch' }).flags['--dry-run'] === true });
  if (command === 'status') return control('status', 'status', {}, tokens(rest, { '--json': 'switch' }));
  if (command === 'projects') return control('projects', 'projects.list', {}, tokens(rest, { '--json': 'switch' }));
  if (command === 'sessions') return sessions(rest, cwd);
  if (command === 'messages') return messages(rest);
  if (command === 'links') return links(rest);
  if (command === 'alias') return alias(rest);
  if (command === 'config') return config(rest, cwd);
  return usage();
}
