// INPUT: The install environment, the installed manifest and config.json (bundle and pinned Python) and one harness.
// OUTPUT: installHarness → dry-run text or result lines; a reinstall first runs uninstall --harness; a failure while writing
//         rolls back only the records this run added.
// POS: ms install --harness: adds or reinstalls one harness plugin on an already installed core.
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Harness } from './args.ts';
import { CliError } from './errors.ts';
import { harnessContext, planHarness, planLines, resultLines, type HarnessStep, type HarnessTarget } from './harness.ts';
import { ledgerContext, save, type Ledger } from './install-apply.ts';
import type { InstallEnv } from './install.ts';
import type { InstallManifest, InstallRecord } from './manifest.ts';
import { revertRecord } from './revert.ts';
import { applyHarnessUninstall, harnessRevertLines, loadManifest } from './uninstall.ts';

async function installed(env: InstallEnv): Promise<Readonly<{ manifest: InstallManifest; target: HarnessTarget }>> {
  const manifest = await loadManifest(env.paths);
  if (manifest.state !== 'installed' || manifest.bundle === null) throw new CliError('NOT_INSTALLED', `manifest state ${manifest.state}`);
  let pythonPath: unknown;
  try { pythonPath = JSON.parse(await readFile(join(env.paths.root, 'config.json'), 'utf8')).python?.path; } catch { pythonPath = undefined; }
  if (typeof pythonPath !== 'string') throw new CliError('MANIFEST_INVALID', 'config.json unreadable');
  const bundleDir = manifest.bundle.path;
  return Object.freeze({ manifest, target: Object.freeze({ bundleDir, pythonPath, bundled: (relative: string) => existsSync(join(bundleDir, relative)) }) });
}

async function step(env: InstallEnv, target: HarnessTarget, harness: Harness): Promise<HarnessStep> {
  const plan = await planHarness(env, target, harness);
  if ('skip' in plan) throw new CliError('INSTALL_PRECONDITION_FAILED', `${plan.skip}; ${plan.manual}`);
  return plan;
}

async function nextBackup(env: InstallEnv): Promise<number> {
  return Math.max(0, ...(await readdir(env.paths.backups)).map(name => Number.parseInt(name, 10)).filter(Number.isInteger));
}

// Reverts the records this run added; the ones that will not revert stay in the ledger for ms uninstall --harness.
async function rollback(env: InstallEnv, ledger: Ledger, start: number, harness: Harness): Promise<string[]> {
  const added = ledger.manifest.records.slice(start);
  const kept: InstallRecord[] = [];
  const conflicts: string[] = [];
  for (const record of [...added].reverse()) {
    const outcome = await revertRecord(record, { dshPnpm: env.dshPnpm, claudeCli: env.claudeCli, codexCli: env.codexCli }).catch(() => Object.freeze({ ok: false, note: `${record.kind} record: revert failed` }));
    if (!outcome.ok) conflicts.push(`CONFLICT ${outcome.note}`);
    if (!outcome.ok || ('retained' in outcome && outcome.retained)) kept.unshift(record);
  }
  await save(env, ledger, { records: Object.freeze([...ledger.manifest.records.slice(0, start), ...kept]) });
  return conflicts.length === 0 ? [] : [...conflicts, `resolve it, then run ms uninstall --harness ${harness}`];
}

export async function installHarness(env: InstallEnv, harness: Harness, dryRun: boolean): Promise<string> {
  const { manifest, target } = await installed(env);
  const reinstall = manifest.records.some(record => record.harness === harness);
  if (dryRun) {
    const body = reinstall
      ? ['reinstall: first revert', ...harnessRevertLines(manifest, harness).map(line => `  ${line}`), `then install ${harness} again (planned after the revert)`]
      : planLines([await step(env, target, harness)]);
    return [`ms install plan for ${harness} (dry run, nothing written):`, ...body.map(line => `  ${line}`)].join('\n');
  }
  if (reinstall) await applyHarnessUninstall(manifest, env.paths, { dshPnpm: env.dshPnpm, claudeCli: env.claudeCli, codexCli: env.codexCli }, harness);
  const plan = await step(env, target, harness);
  const ledger: Ledger = { manifest: await loadManifest(env.paths), backups: await nextBackup(env) };
  const start = ledger.manifest.records.length;
  try { await plan.apply(harnessContext(ledgerContext(env, ledger), harness)); } catch (error) {
    const conflicts = await rollback(env, ledger, start, harness);
    const cause = error instanceof CliError ? [error.code, error.detail].filter(Boolean).join(': ') : 'unexpected error';
    throw new CliError('INSTALL_FAILED', [cause, ...conflicts].join('\n'));
  }
  return [`ms installed ${harness}`, ...resultLines([plan])].join('\n');
}
