// INPUT: The install environment (sourceRoot is the staged new package), the install ledger, the old bundle's CLI runner and msd start/stop.
// OUTPUT: runUpgrade → progress lines and result text (preflight, stop msd, old uninstall --keep-data, install, start msd); systemRun.
// POS: ms upgrade: the old version reverts its own writes, so this code never reads them.
import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { pinSources, type PinnedBundle } from './bundle.ts';
import { CliError } from './errors.ts';
import { HARNESS_ORDER } from './harness.ts';
import { applyInstall, START_HINT } from './install-apply.ts';
import { CLI_ENTRY, pinLines, planInstall, planSources, refuseLongSocketPath, type InstallEnv } from './install.ts';
import type { PinSet } from './pins.ts';
import { CONFIG_FILE, planConfig, readKeptConfig, settingsLines, type ConfigPlan } from './settings.ts';
import { loadManifest } from './uninstall.ts';
import type { Harness } from './args.ts';

export type RunOld = (command: string, args: readonly string[]) => Promise<Readonly<{ code: number; stdout: string; stderr: string }>>;
export type UpgradeDeps = Readonly<{
  env: InstallEnv;
  daemon: (action: 'start' | 'stop') => Promise<string>;
  runOld: RunOld;
  out: (text: string) => void;
}>;
type Old = Readonly<{ node: string; entry: string; version: string }>;
type Checked = Readonly<{ old: Old; pins: PinSet; pinned: PinnedBundle; config: ConfigPlan }>;

const PRECONDITION = 'MS_UPGRADE_PRECONDITION_FAILED';
const FOLLOW_UP: Readonly<Record<Harness, string>> = Object.freeze({
  dsh: 'DSH: restart DSH once so it loads the new plugin',
  'claude-code': 'Claude Code: in Claude sessions that are already open, run /reload-plugins',
  codex: 'Codex: start a new Codex session and trust all six ms hooks again in /hooks; until UserPromptSubmit, PreToolUse and '
    + 'PermissionRequest are trusted, act letters are handled as direct',
});

export const systemRun: RunOld = (command, args) => new Promise(resolve => {
  execFile(command, [...args], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
    resolve(Object.freeze({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : 127, stdout, stderr }));
  });
});

const versionOf = (dir: string) => readFile(join(dir, 'package.json'), 'utf8')
  .then(text => String((JSON.parse(text) as { version?: unknown }).version ?? 'unknown'), () => 'unknown');
const indent = (text: string) => text.trimEnd().split('\n').map(line => `  ${line}`).join('\n');
const cause = (error: unknown) => (error instanceof CliError ? [error.code, error.detail].filter(Boolean).join(': ') : 'INTERNAL_ERROR');

async function inside(dir: string, files: readonly string[]): Promise<boolean> {
  const real = await Promise.all(files.map(file => realpath(file).catch(() => null)));
  return real.every(path => path !== null && path.startsWith(dir + sep));
}

async function check(deps: UpgradeDeps): Promise<Checked> {
  const { env } = deps;
  const { paths } = env;
  refuseLongSocketPath(paths);
  const manifest = await loadManifest(paths).catch((error: unknown) => {
    if (error instanceof CliError && error.code === 'NOT_INSTALLED') throw new CliError('NOT_INSTALLED', 'nothing to upgrade; run ms install');
    throw error;
  });
  if (manifest.state !== 'installed' || manifest.bundle === null) {
    throw new CliError(PRECONDITION, `the install ledger is in state ${manifest.state}; resolve it with ms uninstall first, then ms install`);
  }
  const root = await realpath(paths.root);
  const old = { node: join(manifest.bundle.path, 'runtime', 'node'), entry: join(manifest.bundle.path, CLI_ENTRY), version: await versionOf(manifest.bundle.path) };
  if (!(await inside(join(root, 'bundles'), [old.node, old.entry]))) {
    throw new CliError(PRECONDITION, `the install ledger names ${manifest.bundle.path}, whose runtime/node or ${CLI_ENTRY} does not resolve inside ${paths.bundles}`);
  }
  if (await inside(root, [env.sourceRoot])) {
    throw new CliError(PRECONDITION, `this is the installed copy at ${env.sourceRoot}; run ms upgrade from the npm package (npm i -g agent-message-switchboard@latest, then ms upgrade)`);
  }
  const pins = await env.discoverPins();
  const pinned = await pinSources(await planSources(env));
  const config = planConfig(pins, await readKeptConfig(paths.root), true);
  const help = await deps.runOld(old.node, [old.entry, 'help']);
  if (help.code !== 0) {
    const exit = [`help exited ${help.code}`, help.stderr.trim()].filter(Boolean).join(': ');
    throw new CliError(PRECONDITION, `the installed ${old.version} cannot run its own CLI (${exit}); it has to uninstall itself first: `
      + `fix what "${paths.fallback}" help reports, then rerun ms upgrade`);
  }
  return Object.freeze({ old: Object.freeze(old), pins, pinned, config });
}

async function preflight(deps: UpgradeDeps): Promise<Checked> {
  try { return await check(deps); } catch (error) {
    if (!(error instanceof CliError) || error.code === 'NOT_INSTALLED') throw error;
    throw new CliError(PRECONDITION, `${error.code === PRECONDITION ? error.detail : cause(error)}; nothing was changed`);
  }
}

function direction(from: string, to: string): string {
  if (from === to) return ' (reinstall of the same version)';
  const [a, b] = [from, to].map(version => version.split(/[.+-]/).slice(0, 3).map(Number));
  const first = a.findIndex((part, index) => part !== b[index]);
  return first >= 0 && a[first] > b[first] ? ' (downgrade)' : '';
}

async function uninstallOld(deps: UpgradeDeps, old: Old): Promise<void> {
  deps.out(`uninstall ${old.version} with its own CLI (ms uninstall --keep-data):`);
  const result = await deps.runOld(old.node, [old.entry, 'uninstall', '--keep-data']);
  if (result.stdout.trim()) deps.out(indent(result.stdout));
  if (result.code === 0) return;
  throw new CliError('MS_UPGRADE_UNINSTALL_FAILED', `${old.version}'s uninstall --keep-data exited ${[result.code, result.stderr.trim()].filter(Boolean).join(': ')}\n`
    + `msd is stopped and ${old.version} may be partly removed; state/ and config.json are kept. Resolve what it reports, rerun `
    + `"${deps.env.paths.fallback}" uninstall --keep-data, then ms install`);
}

async function installNew(deps: UpgradeDeps, old: Old, version: string): Promise<readonly Harness[]> {
  deps.out(`install ${version}:`);
  try {
    const plan = await planInstall(deps.env);
    const result = await applyInstall(plan, deps.env);
    deps.out(indent(result.split('\n').filter(line => line !== START_HINT).join('\n')));
    return plan.harnesses.filter(step => !('skip' in step)).map(step => step.harness);
  } catch (error) {
    throw new CliError('MS_UPGRADE_INSTALL_FAILED', `${cause(error)}\nno version of ms is installed now; what uninstall --keep-data kept in `
      + `${deps.env.paths.root} (state/, config.json) is still there. To recover: run ms install again once the cause is fixed, `
      + `or go back with npm i -g agent-message-switchboard@${old.version} and ms install`);
  }
}

// The harness steps are planned only after the old version is gone (its entries are still in the hosts' configs until then).
function describeUpgrade(checked: Checked, version: string, deps: UpgradeDeps): string {
  const { old, pinned, config } = checked;
  const { paths } = deps.env;
  const bytes = pinned.files.reduce((total, file) => total + file.size, 0);
  const assumes = config.outcome === 'kept'
    ? [`    (as long as ${old.version}'s uninstall --keep-data keeps config.json; an older one that drops it leaves every setting at its default)`] : [];
  return [
    `ms upgrade plan (dry run, nothing written): ${old.version} → ${version}${direction(old.version, version)}`,
    '  preflight passed: socket paths, install ledger, installed bundle and its CLI, Python pin, new package, config.json',
    '  stop msd',
    `  run ${old.version}'s own ms uninstall --keep-data, which keeps state/ and config.json (its own plan: "${paths.fallback}" uninstall --dry-run --keep-data)`,
    `  install ${version}:`,
    `    copy bundle ${join(paths.bundles, pinned.digest.slice(0, 16))} (${pinned.files.length} files, ${bytes} bytes, sha256 ${pinned.digest})`,
    `    write ${join(paths.root, CONFIG_FILE)} (0600: pins below)`,
    ...pinLines(checked.pins),
    ...settingsLines(config).map(line => `    ${line}`),
    ...assumes,
    `    then the LaunchAgent, the fallback launcher and the DSH, Claude Code and Codex plugins, each planned once ${old.version} is gone; `
      + 'a harness whose preconditions fail then is skipped with a manual-install pointer',
    '  start msd',
    '  then list the follow-up steps for each harness installed',
  ].join('\n');
}

export async function runUpgrade(deps: UpgradeDeps, dryRun = false): Promise<string> {
  const checked = await preflight(deps);
  const { old } = checked;
  const version = await versionOf(deps.env.sourceRoot);
  if (dryRun) return describeUpgrade(checked, version, deps);
  deps.out(`ms upgrade: ${old.version} → ${version}${direction(old.version, version)}`);
  deps.out(`stop msd: ${await deps.daemon('stop')}`);
  await uninstallOld(deps, old);
  const installed = await installNew(deps, old, version);
  deps.out('start msd:');
  try { deps.out(indent(await deps.daemon('start'))); } catch (error) {
    throw new CliError('MS_UPGRADE_START_FAILED', `${cause(error)}\n${version} is installed; once the cause is fixed, run ms daemon start`);
  }
  const next = HARNESS_ORDER.filter(harness => installed.includes(harness)).map(harness => `  ${FOLLOW_UP[harness]}`);
  return [`ms upgraded ${old.version} → ${version}`, ...(next.length ? ['next:', ...next] : [])].join('\n');
}
