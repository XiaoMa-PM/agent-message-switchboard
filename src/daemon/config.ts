// INPUT: The install-written private msd config file (schemaVersion 4) and control-socket config updates; ACT_HARNESSES and
//        isActPreset from the shared standard.
// OUTPUT: Validated frozen daemon config (python pin, claude.wrapperPins only, per-harness autoRegister, replyMode and actPreset)
//         keyed by protocol harness ids, merged updates and atomic 0600 rewrites; act is refused for a harness not in ACT_HARNESSES,
//         and an older schemaVersion is INVALID_CONFIG, with no fallback.
// POS: msd configuration boundary; Claude identity is code signature (claude-identity), so no Claude binary pins live here.
import { randomUUID } from 'node:crypto';
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { type BinaryPin } from '../adapters/claude/peer-identity.ts';
import { type Harness } from '../protocol/message.ts';
import { ACT_HARNESSES, isActPreset, type ActPreset } from '../protocol/peer-tiers.ts';
import { isReplyMode, type ReplyMode } from '../protocol/reply-mode-text.ts';
import { HARNESSES } from './directory.ts';
import { parseLinkBudget, type LinkBudget } from './switchboard.ts';

export type AutoRegister = Readonly<Record<Harness, boolean>>;
export type ReplyModes = Readonly<Record<Harness, ReplyMode>>;
export type ActPresets = Readonly<Record<Harness, ActPreset>>;
export type ClaudeConfig = Readonly<{ wrapperPins: readonly BinaryPin[] }>;
export type DaemonConfig = Readonly<{ schemaVersion: 4; python: BinaryPin; claude: ClaudeConfig; autoRegister: AutoRegister;
  autoRegisterProjects: readonly string[]; replyMode: ReplyModes; actPreset: ActPresets; linkBudget: LinkBudget }>;
export type ConfigView = Readonly<{ autoRegister: AutoRegister; autoRegisterProjects: readonly string[]; replyMode: ReplyModes;
  actPreset: ActPresets; linkBudget: LinkBudget }>;

const MAX_CONFIG_BYTES = 65536;
function fail(): never { throw new Error('INVALID_CONFIG'); }

function object(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const raw = value as Record<string, unknown>;
  if (!keys.every(name => Object.hasOwn(raw, name))
      || Object.keys(raw).some(name => !keys.includes(name) && !optional.includes(name))) fail();
  return raw;
}

function pin(value: unknown): BinaryPin {
  const raw = object(value, ['path', 'sha256']);
  if (typeof raw.path !== 'string' || !isAbsolute(raw.path) || raw.path.includes('\0')
      || typeof raw.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(raw.sha256)) fail();
  return Object.freeze({ path: raw.path, sha256: raw.sha256 });
}

function pins(value: unknown): readonly BinaryPin[] {
  if (!Array.isArray(value)) fail();
  const list = value.map(pin);
  if (new Set(list.map(item => item.path)).size !== list.length) fail();
  return Object.freeze(list);
}

// config.json uses the short key `claude` for the claude-code protocol id; nothing outside this file uses the short name.
const FILE_FLAG: Readonly<Record<Harness, string>> = Object.freeze({ 'claude-code': 'claude', dsh: 'dsh', codex: 'codex' });

function booleans(raw: Record<string, unknown>): void {
  if (Object.values(raw).some(flag => typeof flag !== 'boolean')) fail();
}

function fileFlags(value: unknown): AutoRegister {
  const raw = object(value, HARNESSES.map(harness => FILE_FLAG[harness]));
  booleans(raw);
  return Object.freeze(Object.fromEntries(HARNESSES.map(harness => [harness, raw[FILE_FLAG[harness]]]))) as AutoRegister;
}

function apiFlags(value: unknown): Partial<AutoRegister> {
  const raw = object(value, [], HARNESSES);
  booleans(raw);
  return Object.freeze({ ...raw }) as Partial<AutoRegister>;
}

type Valid = (harness: Harness, value: unknown) => boolean;
// Act is valid only for a harness listed in ACT_HARNESSES.
const replyModeValid: Valid = (harness, value) => isReplyMode(value) && (value !== 'act' || ACT_HARNESSES.includes(harness));
const actPresetValid: Valid = (_, value) => isActPreset(value);

function fileValues<T>(value: unknown, valid: Valid): Readonly<Record<Harness, T>> {
  const raw = object(value, HARNESSES.map(harness => FILE_FLAG[harness]));
  if (!HARNESSES.every(harness => valid(harness, raw[FILE_FLAG[harness]]))) fail();
  return Object.freeze(Object.fromEntries(HARNESSES.map(harness => [harness, raw[FILE_FLAG[harness]]]))) as Readonly<Record<Harness, T>>;
}

function apiValues<T>(value: unknown, valid: Valid): Partial<Record<Harness, T>> {
  const raw = object(value, [], HARNESSES);
  if (Object.keys(raw).length === 0 || !Object.entries(raw).every(([harness, item]) => valid(harness as Harness, item))) fail();
  return Object.freeze({ ...raw }) as Partial<Record<Harness, T>>;
}

const byFileKey = <T>(values: Readonly<Record<Harness, T>>) =>
  Object.fromEntries(HARNESSES.map(harness => [FILE_FLAG[harness], values[harness]]));

function toFile(config: DaemonConfig) {
  return { ...config, autoRegister: byFileKey(config.autoRegister), replyMode: byFileKey(config.replyMode),
    actPreset: byFileKey(config.actPreset) };
}

function projects(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !isAbsolute(item) || item.includes('\0'))
      || new Set(value).size !== value.length) fail();
  return Object.freeze([...value]);
}

export function autoAllows(config: DaemonConfig, project: string | null): boolean {
  return config.autoRegisterProjects.length === 0 || (project !== null && config.autoRegisterProjects.includes(project));
}

function claudeConfig(value: unknown): ClaudeConfig {
  const wrapperPins = pins(object(value, ['wrapperPins']).wrapperPins);
  if (new Set(wrapperPins.map(item => item.sha256)).size !== wrapperPins.length) fail();
  return Object.freeze({ wrapperPins });
}

export function parseDaemonConfig(value: unknown): DaemonConfig {
  const raw = object(value, ['schemaVersion', 'python', 'claude', 'autoRegister', 'autoRegisterProjects', 'replyMode', 'actPreset',
    'linkBudget']);
  if (raw.schemaVersion !== 4) fail();
  let linkBudget: LinkBudget;
  try { linkBudget = parseLinkBudget(raw.linkBudget); } catch { fail(); }
  return Object.freeze({ schemaVersion: 4, python: pin(raw.python), claude: claudeConfig(raw.claude),
    autoRegister: fileFlags(raw.autoRegister), autoRegisterProjects: projects(raw.autoRegisterProjects),
    replyMode: fileValues<ReplyMode>(raw.replyMode, replyModeValid), actPreset: fileValues<ActPreset>(raw.actPreset, actPresetValid),
    linkBudget });
}

export function configView(config: DaemonConfig): ConfigView {
  return Object.freeze({ autoRegister: config.autoRegister, autoRegisterProjects: config.autoRegisterProjects,
    replyMode: config.replyMode, actPreset: config.actPreset, linkBudget: config.linkBudget });
}

export function mergeConfig(config: DaemonConfig, update: unknown): DaemonConfig {
  const raw = object(update, [], ['autoRegister', 'autoRegisterProjects', 'replyMode', 'actPreset', 'linkBudget']);
  if (Object.keys(raw).length === 0) fail();
  const autoRegister = raw.autoRegister === undefined ? config.autoRegister
    : Object.freeze({ ...config.autoRegister, ...apiFlags(raw.autoRegister) });
  let autoRegisterProjects = config.autoRegisterProjects;
  if (raw.autoRegisterProjects !== undefined) {
    const change = object(raw.autoRegisterProjects, [], ['add', 'remove']);
    if (Object.keys(change).length === 0) fail();
    const add = change.add === undefined ? [] : projects(change.add);
    const remove = change.remove === undefined ? [] : projects(change.remove);
    autoRegisterProjects = Object.freeze([...config.autoRegisterProjects.filter(item => !remove.includes(item)),
      ...add.filter(item => !config.autoRegisterProjects.includes(item) && !remove.includes(item))]);
  }
  const replyMode = raw.replyMode === undefined ? config.replyMode
    : Object.freeze({ ...config.replyMode, ...apiValues<ReplyMode>(raw.replyMode, replyModeValid) });
  const actPreset = raw.actPreset === undefined ? config.actPreset
    : Object.freeze({ ...config.actPreset, ...apiValues<ActPreset>(raw.actPreset, actPresetValid) });
  let linkBudget = config.linkBudget;
  if (raw.linkBudget !== undefined) { try { linkBudget = parseLinkBudget(raw.linkBudget); } catch { fail(); } }
  return Object.freeze({ ...config, autoRegister, autoRegisterProjects, replyMode, actPreset, linkBudget });
}

async function privateFile(path: string): Promise<void> {
  const [file, parent] = await Promise.all([lstat(path), lstat(dirname(path))]);
  const uid = process.getuid!();
  if (!file.isFile() || file.uid !== uid || (file.mode & 0o077) !== 0 || file.size > MAX_CONFIG_BYTES
      || !parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o077) !== 0) fail();
}

export async function readDaemonConfig(path: string): Promise<DaemonConfig> {
  try {
    if (!isAbsolute(path)) fail();
    await privateFile(path);
    return parseDaemonConfig(JSON.parse(await readFile(path, 'utf8')));
  } catch { return fail(); }
}

export async function writeDaemonConfig(path: string, config: DaemonConfig): Promise<void> {
  const temporary = join(dirname(path), `.config-${randomUUID()}.tmp`);
  try {
    const file = toFile(config);
    parseDaemonConfig(file);
    await writeFile(temporary, JSON.stringify(file, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } catch {
    await rm(temporary, { force: true });
    throw new Error('CONFIG_WRITE_FAILED');
  }
}
