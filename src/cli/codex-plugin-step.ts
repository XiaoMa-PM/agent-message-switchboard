// INPUT: ms paths, the Codex marketplace generator, the codex CLI (PATH, else ChatGPT.app's copy) and ~/.codex config.toml.
// OUTPUT: systemCodexCli, planCodexPluginStep (preflight, dry-run lines, journaled apply) and revertCodexPlugin.
// POS: Codex step: installs ms@ms-local from <root>/codex-marketplace with `codex plugin`, then appends the send/reply
//      approval subtables; uninstall runs the removes, restores config.toml byte for byte when untouched, else drops only ms's tables.
import { spawn } from 'node:child_process';
import { readFile, rm, rmdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { CODEX_APPROVE_TOOLS, CODEX_MARKETPLACE, CODEX_MARKETPLACE_DIR, CODEX_PLUGIN, CODEX_PLUGIN_ID, codexPluginVersion,
  type prepareDailyCodexMarketplace } from '../adapters/codex/plugin.ts';
import { hashTree } from './claude-marketplace-step.ts';
import { appendTables, dropTables, tableHeaders } from './codex-toml.ts';
import { CliError } from './errors.ts';
import { pathExists, readOptional, replaceFile, sha256, type FileState } from './fs-ops.ts';
import type { ClaudeStep, StepContext } from './install.ts';
import type { FileSnapshot, InstallRecord } from './manifest.ts';
import type { MsPaths } from './paths.ts';
import { systemPinProbe } from './pins.ts';
import { conflict, done, restoreExact, sameTextLines, type RevertOutcome } from './revert-file.ts';

export const CHATGPT_CODEX = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
export const CODEX_ADAPTER_ENTRY = 'src/adapters/codex/mcp-main.ts';
const CLI_TIMEOUT_MS = 120_000;
const PLUGIN_HEADER = `[plugins.${JSON.stringify(CODEX_PLUGIN_ID)}`;
const MARKETPLACE_HEADER = /^\[\s*marketplaces\s*\.\s*"?ms-local"?\s*\]$/;
const TRUST_HEADER = `[hooks.state.${JSON.stringify(`${CODEX_PLUGIN_ID}:`).slice(0, -1)}`;
const LEFTOVER = /^\s*(?:\[\s*)?(?:marketplaces\s*\.\s*"?ms-local"?\s*[\].=]|plugins\s*\.\s*"ms@ms-local"|hooks\s*\.\s*state\s*\.\s*"ms@ms-local:)/;
// A user's own [mcp_servers.ms] table would silently replace the plugin's ms MCP server.
const MS_SERVER_TABLE = /^\s*\[\s*mcp_servers\s*\.\s*"?ms"?\s*[\].]/;

export type CodexCli = Readonly<{ ready: () => Promise<boolean>; path: () => Promise<string | null>; run: (args: readonly string[]) => Promise<void> }>;
export type CodexGenerator = typeof prepareDailyCodexMarketplace;
export type CodexStepDeps = Readonly<{ paths: MsPaths; generate: CodexGenerator; codex: CodexCli }>;
export type CodexTarget = Readonly<{ bundleDir: string; bundled: (relative: string) => boolean }>;
type CodexRecord = Extract<InstallRecord, { kind: 'codex-plugin' }>;

const verb = (args: readonly string[]) => (args[1] === 'marketplace' ? `marketplace ${args[2]}` : args[1]);

// `codex` on PATH first (the npm CLI), else the copy inside ChatGPT.app; both act on the same ~/.codex.
export function systemCodexCli(pathEnv: string = process.env.PATH ?? '', fallback: string = CHATGPT_CODEX): CodexCli {
  const find = async () => {
    const found = await systemPinProbe(pathEnv).which('codex');
    if (found !== null) return found;
    return (await stat(fallback).then(info => info.isFile() && (info.mode & 0o111) !== 0, () => false)) ? fallback : null;
  };
  return Object.freeze({
    ready: async () => (await find()) !== null,
    path: find,
    run: async (args: readonly string[]) => {
      const codex = await find();
      if (codex === null) throw new CliError('CODEX_CLI_FAILED', 'codex not found');
      await new Promise<void>((settle, fail) => {
        const child = spawn(codex, args, { stdio: 'ignore', timeout: CLI_TIMEOUT_MS });
        child.once('error', () => fail(new CliError('CODEX_CLI_FAILED', `${verb(args)} could not start`)));
        child.once('exit', code => (code === 0 ? settle() : fail(new CliError('CODEX_CLI_FAILED', `${verb(args)} exit ${code ?? 'killed'}`))));
      });
    },
  });
}

function codexPaths(home: string) {
  const codex = join(home, '.codex');
  const plugins = join(codex, 'plugins');
  return Object.freeze({
    config: join(codex, 'config.toml'),
    candidates: [plugins, join(plugins, 'cache'), join(plugins, 'cache', CODEX_MARKETPLACE)],
  });
}

function missing(detail: string): never { throw new CliError('INSTALL_PRECONDITION_FAILED', detail); }

const owns = (text: string) => {
  const headers = tableHeaders(text);
  return Object.freeze({
    plugin: headers.some(header => header.startsWith(PLUGIN_HEADER)),
    marketplace: headers.some(header => MARKETPLACE_HEADER.test(header)),
  });
};

async function preflight(paths: MsPaths, directory: string, target: CodexTarget, codex: CodexCli): Promise<string> {
  if (!(await codex.ready())) missing(`codex CLI not found on PATH or at ${CHATGPT_CODEX}`);
  const files = codexPaths(paths.home);
  const config = await readOptional(files.config);
  if (config === null) missing(`${files.config} not found`);
  if (!target.bundled(CODEX_ADAPTER_ENTRY)) missing(`this build has no ${CODEX_ADAPTER_ENTRY}`);
  if (await pathExists(directory)) missing(`already exists: ${directory}`);
  const text = config!.bytes.toString('utf8');
  const keys = owns(text);
  if (keys.plugin || keys.marketplace) missing(`${CODEX_MARKETPLACE} is already known to Codex; run ms uninstall or codex plugin marketplace remove ${CODEX_MARKETPLACE} first`);
  if (text.split('\n').some(line => MS_SERVER_TABLE.test(line))) missing(`${files.config} already has [mcp_servers.ms]; remove or rename it, then install`);
  return files.config;
}

const shaOf = (state: FileState) => (state === null ? null : sha256(state.bytes));
const approvalTables = () => CODEX_APPROVE_TOOLS.map(tool =>
  ({ header: `[plugins.${JSON.stringify(CODEX_PLUGIN_ID)}.mcp_servers.ms.tools.${tool}]`, body: ['approval_mode = "approve"'] }));

async function apply(deps: CodexStepDeps, target: CodexTarget, directory: string, context: StepContext): Promise<void> {
  const tree = { kind: 'tree', path: directory, captured: false, files: [] } as const;
  await context.journal(tree);
  await deps.generate({ directory, root: deps.paths.root, bundleDir: target.bundleDir });
  await context.amend(Object.freeze({ ...tree, captured: true, files: await hashTree(directory) }));
  const files = codexPaths(deps.paths.home);
  const state = await readOptional(files.config) ?? missing(`${files.config} not found`);
  const absent: string[] = [];
  for (const path of files.candidates) if (!(await pathExists(path))) absent.push(path);
  const record: CodexRecord = Object.freeze({
    kind: 'codex-plugin', marketplace: CODEX_MARKETPLACE, pluginId: CODEX_PLUGIN_ID, absent,
    hooksState: tableHeaders(state.bytes.toString('utf8')).includes('[hooks.state]'),
    config: Object.freeze({ path: files.config, created: false, backup: await context.backup(files.config, state.bytes), mode: state.mode,
      beforeSha: shaOf(state), afterSha: null }),
  });
  await context.journal(record);
  // afterSha is also recorded on failure, so the rollback sees what this run left.
  try {
    await deps.codex.run(['plugin', 'marketplace', 'add', directory]);
    await deps.codex.run(['plugin', 'add', CODEX_PLUGIN_ID]);
    const added = await readOptional(files.config) ?? missing(`${files.config} vanished`);
    await replaceFile(files.config, appendTables(added.bytes.toString('utf8'), approvalTables()), added.mode);
  } finally {
    await context.amend(Object.freeze({ ...record, config: Object.freeze({ ...record.config, afterSha: shaOf(await readOptional(files.config)) }) }));
  }
}

export async function planCodexPluginStep(deps: CodexStepDeps, target: CodexTarget): Promise<ClaudeStep> {
  const directory = join(deps.paths.root, CODEX_MARKETPLACE_DIR);
  const config = await preflight(deps.paths, directory, target, deps.codex);
  const lines = [
    `generate local marketplace ${directory} (${CODEX_MARKETPLACE}; plugin ${CODEX_PLUGIN} ${codexPluginVersion(target.bundleDir)}: MCP server ms, SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, Stop and Interrupt hooks, skills)`,
    `run codex plugin marketplace add ${directory}, then codex plugin add ${CODEX_PLUGIN_ID} (${await deps.codex.path()})`,
    `append ${approvalTables().map(table => table.header).join(', ')} (approval_mode "approve") to ${config}; config.toml is backed up first`,
  ];
  return Object.freeze({ lines, apply: (context: StepContext) => apply(deps, target, directory, context) });
}

async function cleanAbsent(absent: readonly string[]): Promise<void> {
  for (const path of [...absent].reverse()) {
    if (basename(path) === CODEX_MARKETPLACE) { await rm(path, { recursive: true, force: true }); continue; }
    await rmdir(path).catch((error: NodeJS.ErrnoException) => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code ?? '')) throw error; });
  }
}

// ms's own tables, ms's hook trust tables, and a [hooks.state] parent that install did not find and that is now empty.
function dropOwned(text: string, hooksState: boolean): string {
  const once = dropTables(text, header => header.startsWith(PLUGIN_HEADER) || MARKETPLACE_HEADER.test(header) || header.startsWith(TRUST_HEADER));
  const trusts = tableHeaders(once).some(header => header.startsWith('[hooks.state.'));
  return hooksState || trusts ? once
    : dropTables(once, (header, body) => header === '[hooks.state]' && body.every(line => line.trim() === ''));
}

async function revertConfig(record: CodexRecord, codex: CodexCli): Promise<RevertOutcome> {
  const path = record.config.path;
  const current = await readOptional(path);
  if (current === null) return done(`${path}: already absent`);
  const sha = shaOf(current);
  if (sha === record.config.beforeSha) return done(`${path}: unchanged by install`);
  // A record without afterSha (install killed before recording) never counts as untouched: no backup over later edits.
  const untouched = record.config.afterSha !== null && sha === record.config.afterSha;
  const keys = owns(current.bytes.toString('utf8'));
  if (keys.plugin || keys.marketplace) {
    if (!(await codex.ready())) {
      if (!untouched) return conflict(`${path}: codex CLI not found; run codex plugin remove ${CODEX_PLUGIN_ID} and codex plugin marketplace remove ${CODEX_MARKETPLACE}, then rerun`);
      await restoreExact(record.config);
      return done(`${path}: restored exactly (codex CLI not found)`);
    }
    if (keys.plugin) await codex.run(['plugin', 'remove', CODEX_PLUGIN_ID]);
    if (keys.marketplace) await codex.run(['plugin', 'marketplace', 'remove', CODEX_MARKETPLACE]);
  }
  if (untouched) { await restoreExact(record.config); return done(`${CODEX_PLUGIN_ID}: removed with the codex CLI; ${path}: restored exactly`); }
  const after = await readOptional(path) ?? missing(`${path} vanished`);
  const text = dropOwned(after.bytes.toString('utf8'), record.hooksState);
  if (text.split('\n').some(line => LEFTOVER.test(line))) return conflict(`${path}: ms-local entries remain in a form ms does not edit; kept, remove them and rerun`);
  const original = await readFile(record.config.backup!, 'utf8');
  if (sameTextLines(text, original)) { await restoreExact(record.config); return done(`${CODEX_PLUGIN_ID}: removed; ${path}: restored exactly`); }
  await replaceFile(path, text, after.mode);
  return done(`${CODEX_PLUGIN_ID}: removed with the codex CLI, later changes kept`);
}

export async function revertCodexPlugin(record: CodexRecord, codex: CodexCli): Promise<RevertOutcome> {
  try {
    const outcome = await revertConfig(record, codex);
    if (outcome.ok) await cleanAbsent(record.absent);
    return outcome;
  } catch (error) {
    if (error instanceof CliError) return conflict(`${CODEX_PLUGIN_ID}: ${error.detail ?? error.code}`);
    throw error;
  }
}
