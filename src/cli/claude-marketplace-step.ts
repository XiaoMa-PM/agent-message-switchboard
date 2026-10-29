// INPUT: ms paths, the Claude marketplace generator, the claude CLI, and ~/.claude settings.json plus the two plugin registries.
// OUTPUT: systemClaudeCli, planClaudeMarketplaceStep (preflight, dry-run lines, journaled apply), revertClaudePlugin and hashTree.
// POS: Claude step: installs ms@ms-local from <root>/claude-marketplace with the official `claude plugin` commands;
//      uninstall runs them back, restores the three files byte for byte when nobody touched them, and cleans the cache copy.
import { spawn } from 'node:child_process';
import { lstat, readdir, rm, rmdir } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { sha256File } from './bundle.ts';
import { CliError } from './errors.ts';
import { pathExists, readOptional, sha256, type FileState } from './fs-ops.ts';
import type { ClaudeStep, StepContext } from './install.ts';
import type { FileSnapshot, InstallRecord, TreeFile } from './manifest.ts';
import type { MsPaths } from './paths.ts';
import { systemPinProbe } from './pins.ts';
import { conflict, done, restoreExact, type RevertOutcome } from './revert-file.ts';

export const CLAUDE_MARKETPLACE = 'ms-local';
export const CLAUDE_PLUGIN_ID = `ms@${CLAUDE_MARKETPLACE}`;
export const MARKETPLACE_DIR = 'claude-marketplace';
const DATA_ID = CLAUDE_PLUGIN_ID.replace(/[^A-Za-z0-9_-]/g, '-');
const CLI_TIMEOUT_MS = 120_000;

export type PluginGenerator = (options: Readonly<{ directory: string; root: string; pythonPath: string }>) => Promise<void>;
export type ClaudeCli = Readonly<{ ready: () => Promise<boolean>; run: (args: readonly string[]) => Promise<void> }>;
export type ClaudeStepDeps = Readonly<{ paths: MsPaths; generate: PluginGenerator; claude: ClaudeCli }>;
type ClaudeRecord = Extract<InstallRecord, { kind: 'claude-plugin' }>;
type Snapshots = Readonly<{ settings: FileSnapshot; knownMarketplaces: FileSnapshot; installedPlugins: FileSnapshot }>;

const verb = (args: readonly string[]) => (args[1] === 'marketplace' ? `marketplace ${args[2]}` : args[1]);

// The user's claude on PATH, non-interactive (stdin closed), like the `claude plugin …` runs.
export function systemClaudeCli(pathEnv: string = process.env.PATH ?? ''): ClaudeCli {
  const find = () => systemPinProbe(pathEnv).which('claude');
  return Object.freeze({
    ready: async () => (await find()) !== null,
    run: async (args: readonly string[]) => {
      const claude = await find();
      if (claude === null) throw new CliError('CLAUDE_CLI_FAILED', 'claude not on PATH');
      await new Promise<void>((settle, fail) => {
        const child = spawn(claude, args, { stdio: 'ignore', timeout: CLI_TIMEOUT_MS });
        child.once('error', () => fail(new CliError('CLAUDE_CLI_FAILED', `${verb(args)} could not start`)));
        child.once('exit', code => (code === 0 ? settle() : fail(new CliError('CLAUDE_CLI_FAILED', `${verb(args)} exit ${code ?? 'killed'}`))));
      });
    },
  });
}

export async function hashTree(root: string): Promise<TreeFile[]> {
  const found: TreeFile[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name);
      const info = await lstat(path);
      if (info.isDirectory()) { await walk(path); continue; }
      if (!info.isFile()) throw new CliError('UNINSTALL_CONFLICT', `unexpected entry ${relative(root, path)}`);
      found.push(Object.freeze({ path: relative(root, path), sha256: await sha256File(path) }));
    }
  };
  await walk(root);
  return found;
}

function claudePaths(home: string) {
  const claude = join(home, '.claude');
  const plugins = join(claude, 'plugins');
  return Object.freeze({
    settings: join(claude, 'settings.json'), knownMarketplaces: join(plugins, 'known_marketplaces.json'),
    installedPlugins: join(plugins, 'installed_plugins.json'),
    // Directories install may bring into being, parents first; the two named after ms are whole trees ms owns.
    candidates: [plugins, join(plugins, 'marketplaces'), join(plugins, 'cache'), join(plugins, 'cache', CLAUDE_MARKETPLACE),
      join(plugins, 'data'), join(plugins, 'data', DATA_ID)],
  });
}

async function jsonObject(path: string): Promise<Record<string, unknown> | null> {
  const state = await readOptional(path);
  if (state === null) return null;
  try {
    const value = JSON.parse(state.bytes.toString('utf8'));
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch { /* reported below */ }
  throw new CliError('INSTALL_PRECONDITION_FAILED', `${path} is not a JSON object`);
}

const has = (value: unknown, key: string) => value !== null && typeof value === 'object' && Object.hasOwn(value as object, key);

// Which ms keys Claude still holds: the plugin (enabledPlugins / installed_plugins) and the marketplace (both registries).
async function ownedKeys(paths: Readonly<{ settings: string; knownMarketplaces: string; installedPlugins: string }>) {
  const [settings, known, installed] = [await jsonObject(paths.settings), await jsonObject(paths.knownMarketplaces), await jsonObject(paths.installedPlugins)];
  return Object.freeze({
    plugin: has(settings?.enabledPlugins, CLAUDE_PLUGIN_ID) || has(installed?.plugins, CLAUDE_PLUGIN_ID),
    marketplace: has(settings?.extraKnownMarketplaces, CLAUDE_MARKETPLACE) || has(known, CLAUDE_MARKETPLACE),
  });
}

function missing(detail: string): never { throw new CliError('INSTALL_PRECONDITION_FAILED', detail); }

const shaOf = (state: FileState) => (state === null ? null : sha256(state.bytes));

async function snapshot(context: StepContext, path: string, mode: number): Promise<FileSnapshot> {
  const state = await readOptional(path);
  return Object.freeze({
    path, created: state === null, backup: state === null ? null : await context.backup(path, state.bytes),
    mode: state?.mode ?? mode, beforeSha: shaOf(state), afterSha: null,
  });
}

async function apply(deps: ClaudeStepDeps, pythonPath: string, directory: string, context: StepContext): Promise<void> {
  const tree = { kind: 'tree', path: directory, captured: false, files: [] } as const;
  await context.journal(tree);
  await deps.generate({ directory, root: deps.paths.root, pythonPath });
  await context.amend(Object.freeze({ ...tree, captured: true, files: await hashTree(directory) }));
  const paths = claudePaths(deps.paths.home);
  const absent: string[] = [];
  for (const path of paths.candidates) if (!(await pathExists(path))) absent.push(path);
  const record: ClaudeRecord = Object.freeze({
    kind: 'claude-plugin', marketplace: CLAUDE_MARKETPLACE, pluginId: CLAUDE_PLUGIN_ID, absent,
    settings: await snapshot(context, paths.settings, 0o600), knownMarketplaces: await snapshot(context, paths.knownMarketplaces, 0o644),
    installedPlugins: await snapshot(context, paths.installedPlugins, 0o644),
  });
  await context.journal(record);
  const after = async (snap: FileSnapshot) => Object.freeze({ ...snap, afterSha: shaOf(await readOptional(snap.path)) });
  // afterSha is also recorded on failure, so the rollback sees what this run left.
  try {
    await deps.claude.run(['plugin', 'marketplace', 'add', directory]);
    await deps.claude.run(['plugin', 'install', CLAUDE_PLUGIN_ID, '-s', 'user']);
  } finally {
    await context.amend(Object.freeze({
      ...record, settings: await after(record.settings), knownMarketplaces: await after(record.knownMarketplaces),
      installedPlugins: await after(record.installedPlugins),
    }));
  }
}

export async function planClaudeMarketplaceStep(deps: ClaudeStepDeps, options: Readonly<{ pythonPath: string }>): Promise<ClaudeStep> {
  const directory = join(deps.paths.root, MARKETPLACE_DIR);
  if (!(await deps.claude.ready())) missing('claude CLI not found on PATH');
  if (await pathExists(directory)) missing(`already exists: ${directory}`);
  const keys = await ownedKeys(claudePaths(deps.paths.home));
  if (keys.plugin || keys.marketplace) missing(`${CLAUDE_MARKETPLACE} is already known to Claude; run ms uninstall or claude plugin marketplace remove ${CLAUDE_MARKETPLACE} first`);
  const lines = [
    `generate local marketplace ${directory} (${CLAUDE_MARKETPLACE}; plugin ms loads in place from it)`,
    `run claude plugin marketplace add ${directory}, then claude plugin install ${CLAUDE_PLUGIN_ID} -s user`,
    '  claude writes ~/.claude/settings.json (extraKnownMarketplaces, enabledPlugins), plugins/known_marketplaces.json, plugins/installed_plugins.json and a cache copy; the three files are backed up first',
    `  hooks SessionStart/SessionEnd/UserPromptSubmit/PreToolUse/PostToolUse → ${options.pythonPath} ${deps.paths.root}/run/native/runtime_entry.py --daily-client`,
  ];
  return Object.freeze({ lines, apply: (context: StepContext) => apply(deps, options.pythonPath, directory, context) });
}

async function cleanAbsent(absent: readonly string[]): Promise<void> {
  for (const path of [...absent].reverse()) {
    const owned = basename(path) === CLAUDE_MARKETPLACE || basename(path) === DATA_ID;
    if (owned) { await rm(path, { recursive: true, force: true }); continue; }
    await rmdir(path).catch((error: NodeJS.ErrnoException) => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code ?? '')) throw error; });
  }
}

async function restoreAll(snaps: Snapshots): Promise<void> {
  for (const snap of [snaps.settings, snaps.knownMarketplaces, snaps.installedPlugins]) await restoreExact(snap);
}

// Same rule as the DSH bundle: official commands first, exact bytes back only when the three files are still what install wrote
// (a record without afterSha, from an install killed before recording, never counts as untouched).
async function revertFiles(record: ClaudeRecord, claude: ClaudeCli): Promise<RevertOutcome> {
  const snaps = [record.settings, record.knownMarketplaces, record.installedPlugins];
  const states = await Promise.all(snaps.map(snap => readOptional(snap.path)));
  const at = (side: 'beforeSha' | 'afterSha') => snaps.every((snap, index) => shaOf(states[index]) === snap[side]);
  const exact = `${dirname(record.settings.path)} settings.json, plugins/known_marketplaces.json, plugins/installed_plugins.json: restored exactly`;
  if (at('beforeSha')) return done(`${record.settings.path}: Claude files unchanged by install`);
  const keys = await ownedKeys({ settings: record.settings.path, knownMarketplaces: record.knownMarketplaces.path, installedPlugins: record.installedPlugins.path });
  if (!keys.plugin && !keys.marketplace) return done(`${CLAUDE_PLUGIN_ID} already removed from Claude`);
  const untouched = record.settings.afterSha !== null && at('afterSha');
  if (!(await claude.ready())) {
    if (!untouched) return conflict(`claude CLI not found to run claude plugin uninstall; remove ${CLAUDE_PLUGIN_ID} in /plugin, then rerun`);
    await restoreAll(record);
    return done(`${exact} (claude CLI not found)`);
  }
  if (keys.plugin) await claude.run(['plugin', 'uninstall', CLAUDE_PLUGIN_ID, '-s', 'user']);
  if (keys.marketplace) await claude.run(['plugin', 'marketplace', 'remove', CLAUDE_MARKETPLACE]);
  const left = await ownedKeys({ settings: record.settings.path, knownMarketplaces: record.knownMarketplaces.path, installedPlugins: record.installedPlugins.path });
  if (left.plugin || left.marketplace) return conflict(`ms keys still present after the claude CLI; remove ${CLAUDE_PLUGIN_ID} in /plugin, then rerun`);
  if (untouched) { await restoreAll(record); return done(`${CLAUDE_PLUGIN_ID}: removed with the claude CLI; ${exact}`); }
  return done(`${CLAUDE_PLUGIN_ID}: removed with the claude CLI, later changes kept`);
}

export async function revertClaudePlugin(record: ClaudeRecord, claude: ClaudeCli): Promise<RevertOutcome> {
  try {
    const outcome = await revertFiles(record, claude);
    if (outcome.ok) await cleanAbsent(record.absent);
    return outcome;
  } catch (error) {
    if (error instanceof CliError) return conflict(`${CLAUDE_PLUGIN_ID}: ${error.detail ?? error.code}`);
    throw error;
  }
}
