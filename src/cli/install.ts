// INPUT: ms paths, the source checkout root, the Node binary to pin, the Claude plugin step, DSH's pnpm runner and the claude CLI.
// OUTPUT: planInstall (read-only), describePlan (dry-run text), refuseLongSocketPath, planSources and pinLines (reused by upgrade).
// POS: ms install orchestration; every external write is journaled in manifest.json before it happens.
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CliError } from './errors.ts';
import { listSourceFiles, pinSources, runtimePackageDirs, type PinnedBundle, type SourceFile } from './bundle.ts';
import type { ClaudeCli } from './claude-marketplace-step.ts';
import type { CodexCli, CodexTarget } from './codex-plugin-step.ts';
import type { DshPnpm } from './dsh-bundle.ts';
import { pathExists } from './fs-ops.ts';
import { renderPlist } from './launchd.ts';
import type { InstallRecord } from './manifest.ts';
import type { BinaryPin, PinSet } from './pins.ts';
import { planHarnesses, planLines, type HarnessPlan } from './harness.ts';
import { LAUNCH_AGENT_LABEL, type MsPaths } from './paths.ts';
import { CONFIG_FILE, planConfig, readKeptConfig, settingsLines, type ConfigPlan } from './settings.ts';
import { longSocketPath, MAX_SOCKET_PATH_BYTES, SOCKET_PATH_TOO_LONG } from '../daemon/paths.ts';

export const BUNDLE_INCLUDES: readonly string[] = Object.freeze(['package.json', 'src', 'plugins/ms-dsh']);
// The title worker and its launcher import the Claude SDK, a devDependency that is never bundled.
export const BUNDLE_EXCLUDES: readonly string[] = Object.freeze(['src/adapters/claude/metadata-worker.mjs', 'src/adapters/claude/metadata.ts']);
export const DAEMON_ENTRY = 'src/daemon/main.ts';
export const CLI_ENTRY = 'src/cli/entry.ts';
export const STATE_DIR = 'state';
const RUN_DIR = 'run';

export type Journal = (record: InstallRecord) => Promise<void>;
export type StepContext = Readonly<{
  journal: Journal;
  amend: (record: InstallRecord) => Promise<void>;
  backup: (path: string, bytes: Buffer) => Promise<string>;
}>;
export type ClaudeStep = Readonly<{ lines: readonly string[]; apply: (context: StepContext) => Promise<void> }>;
export type InstallEnv = Readonly<{
  paths: MsPaths;
  sourceRoot: string;
  nodePath: string;
  now: () => string;
  discoverPins: () => Promise<PinSet>;
  planClaude: (options: Readonly<{ pythonPath: string }>) => Promise<ClaudeStep>;
  dshPnpm: DshPnpm;
  claudeCli: ClaudeCli;
  planCodex: (target: CodexTarget) => Promise<ClaudeStep>;
  codexCli: CodexCli;
}>;

export type InstallPlan = Readonly<{
  rootExisted: boolean; sources: readonly SourceFile[]; pinned: PinnedBundle; bundleDir: string; pins: PinSet; config: ConfigPlan;
  dirs: readonly string[]; plist: string; fallback: string; harnesses: readonly HarnessPlan[];
}>;

function quoteShell(text: string): string { return `'${text.replaceAll("'", "'\\''")}'`; }

async function preflight(paths: MsPaths): Promise<boolean> {
  if (await pathExists(paths.manifest)) throw new CliError('INSTALL_ALREADY_PRESENT');
  if (await pathExists(paths.launchAgent)) throw new CliError('INSTALL_PRECONDITION_FAILED', `already exists: ${paths.launchAgent}`);
  if (!(await pathExists(paths.root))) return false;
  const entries = await readdir(paths.root);
  if (entries.some(name => name !== STATE_DIR && name !== RUN_DIR && name !== CONFIG_FILE)) throw new CliError('INSTALL_PRECONDITION_FAILED', `already exists: ${paths.root}`);
  return true;
}

export async function planSources(env: InstallEnv): Promise<SourceFile[]> {
  // npm-shrinkwrap.json, not package-lock.json: npm never publishes a package-lock, and the shrinkwrap pins what npm i -g installs.
  const lock = await readFile(join(env.sourceRoot, 'npm-shrinkwrap.json'), 'utf8');
  const packages = await runtimePackageDirs(env.sourceRoot, lock);
  const files = (await listSourceFiles(env.sourceRoot, [...BUNDLE_INCLUDES, ...packages])).filter(file => !BUNDLE_EXCLUDES.includes(file.relative));
  const node = Object.freeze({ relative: 'runtime/node', source: env.nodePath, executable: true });
  return [...files, node].sort((a, b) => (a.relative < b.relative ? -1 : 1));
}

async function missingDirs(targets: readonly string[], home: string): Promise<string[]> {
  const missing: string[] = [];
  for (const target of targets) {
    const chain: string[] = [];
    for (let dir = target; dir !== home && !(await pathExists(dir)); dir = dirname(dir)) chain.unshift(dir);
    for (const dir of chain) if (!missing.includes(dir)) missing.push(dir);
  }
  return missing;
}

export function refuseLongSocketPath(paths: MsPaths): void {
  const long = longSocketPath(paths.root);
  if (long !== null) {
    throw new CliError(SOCKET_PATH_TOO_LONG, `${long.path} is ${long.bytes} bytes; macOS allows at most ${MAX_SOCKET_PATH_BYTES} bytes for a Unix socket path`);
  }
}

export async function planInstall(env: InstallEnv): Promise<InstallPlan> {
  refuseLongSocketPath(env.paths);
  const rootExisted = await preflight(env.paths);
  const kept = rootExisted ? await readKeptConfig(env.paths.root) : null;
  const pins = await env.discoverPins();
  const sources = await planSources(env);
  const pinned = await pinSources(sources);
  const bundleDir = join(env.paths.bundles, pinned.digest.slice(0, 16));
  const node = join(bundleDir, 'runtime', 'node');
  const plist = renderPlist({
    label: LAUNCH_AGENT_LABEL, program: [node, join(bundleDir, DAEMON_ENTRY)], workingDirectory: bundleDir,
    stdoutPath: join(env.paths.logs, 'msd.out.log'), stderrPath: join(env.paths.logs, 'msd.err.log'),
  });
  const fallback = `#!/bin/sh\nexec ${quoteShell(node)} ${quoteShell(join(bundleDir, CLI_ENTRY))} "$@"\n`;
  const dirs = await missingDirs([dirname(env.paths.launchAgent)], env.paths.home);
  const harnesses = await planHarnesses(env, {
    bundleDir, pythonPath: pins.python.path, bundled: relative => sources.some(file => file.relative === relative),
  });
  return Object.freeze({ rootExisted, sources, pinned, bundleDir, pins, config: planConfig(pins, kept, rootExisted), dirs, plist, fallback, harnesses });
}

export function pinLines(pins: PinSet): string[] {
  const all: Array<[string, BinaryPin]> = [
    ['python', pins.python], ...pins.claude.wrapperPins.map(pin => ['wrapper', pin] as [string, BinaryPin]),
  ];
  return all.map(([label, pin]) => `    pin ${label} ${pin.path} (${pin.sha256.slice(0, 12)})`);
}

export function describePlan(plan: InstallPlan, paths: MsPaths): string {
  const bytes = plan.pinned.files.reduce((total, file) => total + file.size, 0);
  return [
    'ms install plan (dry run, nothing written):',
    `  ${plan.rootExisted ? 'reuse private root (kept state/)' : 'create private root'} ${paths.root} (0700)`,
    `  write ${join(paths.root, CONFIG_FILE)} (0600: pins below${plan.config.outcome === 'fresh' ? ', auto-register off, link budget 30/600 s' : ''})`,
    ...pinLines(plan.pins),
    ...settingsLines(plan.config).map(line => `    ${line}`),
    `  copy bundle ${plan.bundleDir} (${plan.pinned.files.length} files, ${bytes} bytes, sha256 ${plan.pinned.digest})`,
    ...plan.dirs.map(dir => `  create directory ${dir}`),
    `  create LaunchAgent ${paths.launchAgent} (not loaded; use ms daemon start)`,
    `  write fallback launcher ${paths.fallback} (not on PATH; the ms command comes from npm)`,
    ...planLines(plan.harnesses).map(line => `  ${line}`),
  ].join('\n');
}
