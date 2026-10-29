// INPUT: The kept private root's config.json bytes (if any), freshly discovered pins and msd's parseDaemonConfig.
// OUTPUT: readKeptConfig (a config.json that is not a plain file is INSTALL_PRECONDITION_FAILED), planConfig → the config.json text
//         install writes plus the previous bytes (put back on rollback), and settingsLines (kept, or each setting back to default).
// POS: ms install's settings carry-over after uninstall --keep-data; never converts between schemas.
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDaemonConfig } from '../daemon/config.ts';
import { CliError } from './errors.ts';
import type { PinSet } from './pins.ts';

export const CONFIG_FILE = 'config.json';
const SCHEMA_VERSION = 4;
const DEFAULT_SETTINGS = Object.freeze({
  autoRegister: { claude: false, dsh: false, codex: false }, autoRegisterProjects: [],
  replyMode: { claude: 'direct', dsh: 'direct', codex: 'direct' },
  actPreset: { claude: 'workspace-write', dsh: 'workspace-write', codex: 'workspace-write' },
  linkBudget: { windowSeconds: 600, maxPushes: 30 },
});
type Setting = keyof typeof DEFAULT_SETTINGS;
const SETTINGS = Object.freeze(Object.keys(DEFAULT_SETTINGS) as Setting[]);
const DEFAULT_TEXT: Readonly<Record<Setting, string>> = Object.freeze({
  autoRegister: 'off for every harness', autoRegisterProjects: 'empty (every project)', replyMode: 'direct for every harness',
  actPreset: 'workspace-write for every harness', linkBudget: '30 pushes per 600 s',
});

export type ConfigPlan = Readonly<{
  text: string; previous: Buffer | null; outcome: 'fresh' | 'kept' | 'defaults'; reason: string | null;
}>;

export async function readKeptConfig(root: string): Promise<Buffer | null> {
  const path = join(root, CONFIG_FILE);
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
  if (info === null) return null;
  if (!info.isFile()) throw new CliError('INSTALL_PRECONDITION_FAILED', `not a regular file: ${path}`);
  return readFile(path);
}

function render(pins: PinSet, settings: object): string {
  return `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, python: pins.python, claude: pins.claude, ...settings }, null, 2)}\n`;
}

// The whole kept file must have this version's schemaVersion and pass msd's own checks; then its settings carry over as they are.
function keptSettings(previous: Buffer): Readonly<{ settings: object } | { reason: string }> {
  let raw: unknown;
  try { raw = JSON.parse(previous.toString('utf8')); } catch { return { reason: 'the kept config.json is not valid JSON' }; }
  const version = (raw as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (version !== SCHEMA_VERSION) {
    return { reason: `the kept config.json has schemaVersion ${JSON.stringify(version) ?? 'none'}, this version uses ${SCHEMA_VERSION}` };
  }
  try { parseDaemonConfig(raw); } catch { return { reason: "the kept config.json fails this version's checks" }; }
  const file = raw as Record<string, unknown>;
  return { settings: Object.fromEntries(SETTINGS.map(key => [key, file[key]])) };
}

export function planConfig(pins: PinSet, previous: Buffer | null, rootExisted: boolean): ConfigPlan {
  if (previous === null) {
    return Object.freeze({ text: render(pins, DEFAULT_SETTINGS), previous, outcome: rootExisted ? 'defaults' : 'fresh',
      reason: rootExisted ? 'the kept private root has no config.json' : null });
  }
  const kept = keptSettings(previous);
  if ('settings' in kept) return Object.freeze({ text: render(pins, kept.settings), previous, outcome: 'kept', reason: null });
  return Object.freeze({ text: render(pins, DEFAULT_SETTINGS), previous, outcome: 'defaults', reason: kept.reason });
}

export function settingsLines(config: ConfigPlan): string[] {
  if (config.outcome === 'fresh') return [];
  if (config.outcome === 'kept') return [`settings kept from the previous config.json: ${SETTINGS.join(', ')} (Python pin re-detected)`];
  return [`settings back to defaults (${config.reason}):`, ...SETTINGS.map(key => `  ${key}: ${DEFAULT_TEXT[key]}`)];
}
