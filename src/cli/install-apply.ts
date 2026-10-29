// INPUT: A frozen InstallPlan, ms paths, a clock and DSH's pnpm runner.
// OUTPUT: applyInstall → summary text (journals each record before its write, rolls back on failure); clearRoot (--keep-data).
// POS: The only writer for ms install: private root, bundle, LaunchAgent, fallback launcher, then the DSH bundle and Claude entries.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { copyBundle } from './bundle.ts';
import { CliError } from './errors.ts';
import { makePrivateDir, sha256 } from './fs-ops.ts';
import { emptyManifest, writeManifest, type InstallManifest, type InstallRecord } from './manifest.ts';
import { revertRecord, type RevertOutcome } from './revert.ts';
import { harnessContext, resultLines } from './harness.ts';
import { CONFIG_FILE, settingsLines } from './settings.ts';
import { STATE_DIR, type InstallEnv, type InstallPlan, type Journal, type StepContext } from './install.ts';

export type Ledger = { manifest: InstallManifest; backups: number };
export const START_HINT = 'next: ms daemon start';

export async function save(env: InstallEnv, ledger: Ledger, change: Partial<InstallManifest>): Promise<void> {
  ledger.manifest = Object.freeze({ ...ledger.manifest, ...change });
  await writeManifest(env.paths.manifest, ledger.manifest);
}

async function writeBackup(env: InstallEnv, ledger: Ledger, path: string, bytes: Buffer): Promise<string> {
  ledger.backups += 1;
  const backup = join(env.paths.backups, `${ledger.backups}-${basename(path)}`);
  await writeFile(backup, bytes, { mode: 0o600, flag: 'wx' });
  return backup;
}

async function createRoot(plan: InstallPlan, env: InstallEnv): Promise<void> {
  if (!plan.rootExisted) {
    try { await makePrivateDir(env.paths.root); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new CliError('INSTALL_PRECONDITION_FAILED', 'Application Support missing');
      throw error;
    }
  }
  for (const dir of [env.paths.installDir, env.paths.backups, env.paths.logs, env.paths.bundles]) await makePrivateDir(dir);
  await writeConfig(env.paths.root, plan.config.text);
}

// Replaces config.json in one rename, so a kept one is never half overwritten.
async function writeConfig(root: string, content: string | Buffer): Promise<void> {
  const temporary = join(root, `.config-${randomUUID()}.tmp`);
  await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
  await rename(temporary, join(root, CONFIG_FILE));
}

async function restoreConfig(root: string, previous: Buffer | null): Promise<void> {
  if (previous === null) await rm(join(root, CONFIG_FILE), { force: true });
  else await writeConfig(root, previous);
}

export type Remove = (path: string) => Promise<void>;
const RETRYABLE = new Set(['ENOTEMPTY', 'EBUSY', 'EPERM', 'EEXIST']);
// 5 attempts per path: a still-running DSH plugin can write its beacon during the removal window, and one write (mkdir run/,
// temp file, rename) can fail at most two removal attempts.
const REMOVE_ATTEMPTS = 5;
const REMOVE_DELAY_MS = 20;
const defaultRemove: Remove = path => rm(path, { recursive: true, force: true });

async function removeWithRetry(path: string, remove: Remove): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try { await remove(path); return; } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
      if (!RETRYABLE.has(code) || attempt >= REMOVE_ATTEMPTS) throw new CliError('ROOT_REMOVE_FAILED', `${path}: ${code}`);
      await new Promise(resolve => setTimeout(resolve, REMOVE_DELAY_MS * attempt));
    }
  }
}

async function entries(root: string): Promise<string[] | null> {
  try { return await readdir(root); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

const KEPT_DATA: readonly string[] = Object.freeze([STATE_DIR, CONFIG_FILE]);

export async function clearRoot(root: string, keepData: boolean, remove: Remove = defaultRemove): Promise<void> {
  const ledger = 'install';
  const names = await entries(root);
  if (names === null) return;
  for (const name of names.filter(item => item !== ledger && !(keepData && KEPT_DATA.includes(item)))) {
    await removeWithRetry(join(root, name), remove);
  }
  if (names.includes(ledger)) await removeWithRetry(join(root, ledger), remove);
  if (!keepData) { await removeWithRetry(root, remove); return; }
  for (const name of (await entries(root)) ?? []) {
    if (!KEPT_DATA.includes(name)) await removeWithRetry(join(root, name), remove);
  }
}

// The copied Node runs msd and the CLI from now on; a copy that does not even report its version fails install here.
async function checkNode(node: string): Promise<void> {
  const stdout = await promisify(execFile)(node, ['--version'], { timeout: 10_000 }).then(result => result.stdout, () => '');
  if (!/^v\d+\.\d+\.\d+/.test(stdout)) throw new CliError('INSTALL_FAILED', 'the bundled Node does not run');
}

async function installBundle(plan: InstallPlan, env: InstallEnv, ledger: Ledger): Promise<void> {
  const staging = join(env.paths.bundles, '.staging');
  await copyBundle(plan.sources, staging, plan.pinned);
  await rename(staging, plan.bundleDir);
  await checkNode(join(plan.bundleDir, 'runtime', 'node'));
  await save(env, ledger, { bundle: Object.freeze({ path: plan.bundleDir, digest: plan.pinned.digest, files: plan.pinned.files.length }) });
}

async function createFile(journal: Journal, path: string, content: string, mode: number): Promise<void> {
  await journal({ kind: 'create', path, sha256: sha256(content) });
  await writeFile(path, content, { mode, flag: 'wx' });
}

// Returns the conflict notes; with any conflict the root (with backups) stays and the ledger keeps only unresolved records.
async function rollback(plan: InstallPlan, env: InstallEnv, ledger: Ledger): Promise<string[]> {
  const conflicts: string[] = [];
  const unresolved: InstallRecord[] = [];
  for (const record of [...ledger.manifest.records].reverse()) {
    let outcome: RevertOutcome;
    try { outcome = await revertRecord(record, { dshPnpm: env.dshPnpm, claudeCli: env.claudeCli, codexCli: env.codexCli }); } catch { outcome = Object.freeze({ ok: false, note: `${record.kind} record: revert failed` }); }
    if (!outcome.ok) conflicts.push(`CONFLICT ${outcome.note}`);
    if (!outcome.ok || outcome.retained) unresolved.unshift(record);
  }
  if (conflicts.length === 0) {
    await clearRoot(env.paths.root, plan.rootExisted);
    if (plan.rootExisted) await restoreConfig(env.paths.root, plan.config.previous);
    return conflicts;
  }
  await save(env, ledger, { state: 'conflict', records: Object.freeze(unresolved) });
  return conflicts;
}

async function writeAll(plan: InstallPlan, env: InstallEnv, ledger: Ledger, journal: Journal): Promise<void> {
  await installBundle(plan, env, ledger);
  for (const dir of plan.dirs) {
    await journal({ kind: 'mkdir', path: dir });
    await mkdir(dir, { mode: 0o700 });
  }
  await createFile(journal, env.paths.launchAgent, plan.plist, 0o644);
  await makePrivateDir(dirname(env.paths.fallback));
  await writeFile(env.paths.fallback, plan.fallback, { mode: 0o700, flag: 'wx' });
  const context = ledgerContext(env, ledger);
  for (const step of plan.harnesses) if (!('skip' in step)) await step.apply(harnessContext(context, step.harness));
}

// Journal/amend/backup over one ledger; amend replaces the last journaled record.
export function ledgerContext(env: InstallEnv, ledger: Ledger): StepContext {
  return Object.freeze({
    journal: async (record: InstallRecord) => save(env, ledger, { records: Object.freeze([...ledger.manifest.records, record]) }),
    amend: async (record: InstallRecord) => save(env, ledger, { records: Object.freeze([...ledger.manifest.records.slice(0, -1), record]) }),
    backup: (path: string, bytes: Buffer) => writeBackup(env, ledger, path, bytes),
  });
}

export async function applyInstall(plan: InstallPlan, env: InstallEnv): Promise<string> {
  const ledger: Ledger = { manifest: emptyManifest(env.now()), backups: 0 };
  const journal: Journal = ledgerContext(env, ledger).journal;
  try {
    await createRoot(plan, env);
    await writeManifest(env.paths.manifest, ledger.manifest);
    await writeAll(plan, env, ledger, journal);
    await save(env, ledger, { state: 'installed' });
  } catch (error) {
    const conflicts = await rollback(plan, env, ledger);
    const cause = error instanceof CliError ? [error.code, error.detail].filter(Boolean).join(': ') : 'unexpected error';
    const detail = conflicts.length === 0 ? cause : [cause, 'rollback hit a conflict:', ...conflicts,
      `private root kept with backups: ${env.paths.root}; resolve it, then run ms uninstall`].join('\n');
    throw new CliError(error instanceof CliError && error.code === 'INSTALL_PRECONDITION_FAILED' ? error.code : 'INSTALL_FAILED', detail);
  }
  return [`ms installed: ${plan.bundleDir}`, `records: ${ledger.manifest.records.length}`, ...settingsLines(plan.config), ...resultLines(plan.harnesses),
    START_HINT].join('\n');
}
