// INPUT: ms paths, the install manifest on disk, an injected launchctl runner and DSH's pnpm runner.
// OUTPUT: loadManifest, describeUninstall (dry-run text) and applyUninstall (stop LaunchAgent, revert records in reverse,
//         write the ledger back when the root itself cannot be removed); describeHarnessUninstall/applyHarnessUninstall
//         revert one harness's records only, keeping the core and the other harnesses.
// POS: ms uninstall; removes the private root only when every record reverted without conflict.
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CliError } from './errors.ts';
import { bootoutService, type Launchctl } from './launchd.ts';
import { parseManifest, writeManifest, type InstallManifest, type InstallRecord } from './manifest.ts';
import { LAUNCH_AGENT_LABEL, type MsPaths } from './paths.ts';
import { revertRecord, type RevertDeps } from './revert.ts';
import type { Harness } from './args.ts';
import { clearRoot, type Remove } from './install-apply.ts';
import { DSH_PACKAGE, type DshPnpm } from './dsh-bundle.ts';
import type { ClaudeCli } from './claude-marketplace-step.ts';
import type { CodexCli } from './codex-plugin-step.ts';

export type UninstallDeps = Readonly<{
  paths: MsPaths; launchctl: Launchctl; uid: number; dshPnpm: DshPnpm; claudeCli: ClaudeCli; codexCli: CodexCli; remove?: Remove;
}>;

export async function loadManifest(paths: MsPaths): Promise<InstallManifest> {
  let text: string;
  try { text = await readFile(paths.manifest, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new CliError('NOT_INSTALLED');
    throw error;
  }
  return parseManifest(text);
}

export function recordLine(record: InstallRecord): string {
  if (record.kind === 'mkdir') return `remove directory if empty ${record.path}`;
  if (record.kind === 'create') return `remove ${record.path} if unchanged`;
  if (record.kind === 'claude-plugin') {
    return `remove ${record.pluginId} and marketplace ${record.marketplace} from Claude (claude plugin uninstall / marketplace remove; exact restore when untouched) and its cache copy`;
  }
  if (record.kind === 'dsh-bundle') {
    return `remove ${record.packageName} from DSH profile ${dirname(record.packageJson.path)} (exact restore, else DSH pnpm remove) and its plugin-page switch row`;
  }
  if (record.kind === 'codex-plugin') {
    return `remove ${record.pluginId} and marketplace ${record.marketplace} from Codex (codex plugin remove / marketplace remove; exact restore when untouched, else only ms's tables and trust records) and its cache copy`;
  }
  return `remove ${record.path} if every file is unchanged`;
}

export function describeUninstall(manifest: InstallManifest, paths: MsPaths, keepData: boolean): string {
  return [
    `ms uninstall plan (dry run, nothing written; manifest state ${manifest.state}):`,
    `  stop LaunchAgent ${LAUNCH_AGENT_LABEL} if loaded`,
    ...[...manifest.records].reverse().map(record => `  ${recordLine(record)}`),
    keepData ? `  remove private root ${paths.root} except state/ and config.json when no conflict remains`
      : `  remove private root ${paths.root} (including state/) when no conflict remains`,
  ].join('\n');
}

// clearRoot drops install/ just before the root itself; if the root still cannot go, the ledger is written back so a rerun
// (every record already reverted reads as absent or unchanged) can finish the removal.
async function keepLedger(paths: MsPaths, manifest: InstallManifest): Promise<void> {
  await mkdir(paths.installDir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
  await writeManifest(paths.manifest, manifest);
}

export async function applyUninstall(manifest: InstallManifest, deps: UninstallDeps, keepData: boolean): Promise<string> {
  await bootoutService(deps.launchctl, `gui/${deps.uid}`, LAUNCH_AGENT_LABEL);
  const notes: string[] = [];
  const unresolved: InstallRecord[] = [];
  let conflicts = 0;
  for (const record of [...manifest.records].reverse()) {
    const outcome = await revertRecord(record, { dshPnpm: deps.dshPnpm, claudeCli: deps.claudeCli, codexCli: deps.codexCli });
    notes.push(`${outcome.ok ? 'ok' : 'CONFLICT'} ${outcome.note}`);
    if (!outcome.ok) conflicts += 1;
    if (!outcome.ok || outcome.retained) unresolved.unshift(record);
  }
  if (conflicts) {
    await writeManifest(deps.paths.manifest, Object.freeze({ ...manifest, state: 'conflict', records: Object.freeze(unresolved) }));
    throw new CliError('UNINSTALL_CONFLICT', `\n${notes.join('\n')}\nprivate root kept with backups: ${deps.paths.root}`);
  }
  try { await clearRoot(deps.paths.root, keepData, deps.remove); } catch (error) {
    if (error instanceof CliError && error.code === 'ROOT_REMOVE_FAILED') await keepLedger(deps.paths, manifest);
    throw error;
  }
  const restart = manifest.records.some(record => record.kind === 'dsh-bundle') ? [`restart DSH so it unloads ${DSH_PACKAGE}`] : [];
  return ['ms uninstalled', ...notes, keepData ? `removed ${deps.paths.root} except state/ and config.json` : `removed ${deps.paths.root}`, ...restart].join('\n');
}

function ownRecords(manifest: InstallManifest, harness: Harness): readonly InstallRecord[] {
  const own = manifest.records.filter(record => record.harness === harness);
  if (own.length === 0) throw new CliError('NOT_INSTALLED', `${harness} was not installed by ms`);
  return own;
}

export function harnessRevertLines(manifest: InstallManifest, harness: Harness): string[] {
  return [...ownRecords(manifest, harness)].reverse().map(recordLine);
}

export function describeHarnessUninstall(manifest: InstallManifest, harness: Harness): string {
  return [`ms uninstall plan for ${harness} (dry run, nothing written):`, ...harnessRevertLines(manifest, harness).map(line => `  ${line}`)].join('\n');
}

export async function applyHarnessUninstall(manifest: InstallManifest, paths: MsPaths, deps: RevertDeps, harness: Harness): Promise<string> {
  const own = ownRecords(manifest, harness);
  const notes: string[] = [];
  const unresolved = new Set<InstallRecord>();
  let conflicts = 0;
  for (const record of [...own].reverse()) {
    const outcome = await revertRecord(record, deps);
    notes.push(`${outcome.ok ? 'ok' : 'CONFLICT'} ${outcome.note}`);
    if (!outcome.ok) conflicts += 1;
    if (!outcome.ok || outcome.retained) unresolved.add(record);
  }
  const records = manifest.records.filter(record => record.harness !== harness || unresolved.has(record));
  await writeManifest(paths.manifest, Object.freeze({ ...manifest, records: Object.freeze(records) }));
  if (conflicts) throw new CliError('UNINSTALL_CONFLICT', `\n${notes.join('\n')}\nrerun ms uninstall --harness ${harness} once it is resolved`);
  return [`ms uninstalled ${harness}`, ...notes, ...(harness === 'dsh' ? [`restart DSH so it unloads ${DSH_PACKAGE}`] : [])].join('\n');
}
