// INPUT: The DSH desktop profile (package.json, pnpm-lock.yaml, node_modules, cordis.patch.yml), the pinned bundle and DSH's pnpm.
// OUTPUT: systemDshPnpm, planDsh, describeDsh, applyDsh and revertDsh (exact bytes back when untouched, else a conflict).
// POS: DSH step: installs plugins/ms-dsh as the local bundle agent-message-switchboard-dsh (pnpm add link:, dsh.profile.bundles).
import { spawn } from 'node:child_process';
import { lstat, readlink, realpath, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { removeOverrideRows, mentionsId } from './dsh-patch.ts';
import { CliError } from './errors.ts';
import { pathExists, readOptional, replaceFile, sha256, withLockFile, type FileState } from './fs-ops.ts';
import type { StepContext } from './install.ts';
import type { FileSnapshot, InstallRecord } from './manifest.ts';
import type { MsPaths } from './paths.ts';
import { conflict, done, restoreExact, type RevertOutcome } from './revert-file.ts';

export const DSH_PACKAGE = 'agent-message-switchboard-dsh';
export const DSH_ENTRY_ID = 'ms-dsh-client';
export const DSH_PLUGIN_DIR = 'plugins/ms-dsh';
export const DSH_APP = '/Applications/DeepSeek Harness.app';
const PNPM_TIMEOUT_MS = 600_000;
const SCRUBBED = /KEY|PASSWORD|SECRET|TOKEN/i;

export type DshPnpm = Readonly<{ ready: () => Promise<boolean>; run: (cwd: string, args: readonly string[]) => Promise<void> }>;
type DshRecord = Extract<InstallRecord, { kind: 'dsh-bundle' }>;
type Manifest = Record<string, unknown> & { dependencies?: Record<string, unknown>; dsh?: { profile?: { bundles?: unknown } } };
export type DshPlan = Readonly<{
  profile: string; lockPath: string; patchPath: string; link: string; target: string; spec: string;
  packageJson: Readonly<{ path: string; original: FileState }>; pnpmLock: Readonly<{ path: string; original: FileState }>;
}>;

// Same command, argv prefix and environment as DSH's plugin manager (packageManager from dsh-desktop-host, scrubbedParentEnv).
export function systemDshPnpm(app: string = DSH_APP, parent: NodeJS.ProcessEnv = process.env): DshPnpm {
  const exec = join(app, 'Contents', 'MacOS', 'DeepSeek Harness');
  const runtime = join(app, 'Contents', 'Resources', 'runtime');
  const pnpm = join(runtime, 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs');
  const env = Object.fromEntries(Object.entries(parent).filter(([key]) => !SCRUBBED.test(key) && !key.toUpperCase().startsWith('DSH_')));
  Object.assign(env, { ELECTRON_RUN_AS_NODE: '1', DSH_DESKTOP_NODE_EXECUTABLE: exec, PATH: `${join(runtime, 'bin')}:${parent.PATH ?? ''}` });
  return Object.freeze({
    ready: async () => (await pathExists(exec)) && (await pathExists(pnpm)),
    run: (cwd: string, args: readonly string[]) => new Promise<void>((settle, fail) => {
      const child = spawn(exec, ['--expose-internals', pnpm, ...args], { cwd, env, stdio: 'ignore', timeout: PNPM_TIMEOUT_MS });
      child.once('error', () => fail(new CliError('DSH_PNPM_FAILED', `${args[0]} could not start`)));
      child.once('exit', code => (code === 0 ? settle() : fail(new CliError('DSH_PNPM_FAILED', `${args[0]} exit ${code ?? 'killed'}`))));
    }),
  });
}

function parseManifest(state: FileState): Manifest {
  let value: unknown;
  try { value = state === null ? null : JSON.parse(state.bytes.toString('utf8')); } catch { value = null; }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CliError('INSTALL_PRECONDITION_FAILED', 'DSH profile package.json missing or not an object');
  }
  return value as Manifest;
}

const bundlesOf = (manifest: Manifest): unknown[] =>
  (Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh!.profile!.bundles as unknown[] : []);
const present = (manifest: Manifest) => Object.hasOwn(manifest.dependencies ?? {}, DSH_PACKAGE) || bundlesOf(manifest).includes(DSH_PACKAGE);

// DSH selectBundle: 2-space JSON, trailing newline, 0600.
async function writeBundles(path: string, manifest: Manifest, bundles: unknown[]): Promise<void> {
  const next = { ...manifest, dsh: { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } } };
  await replaceFile(path, `${JSON.stringify(next, undefined, 2)}\n`, 0o600);
}

export async function planDsh(paths: MsPaths, bundleDir: string, pnpm: DshPnpm): Promise<DshPlan> {
  const profile = join(paths.home, '.dsh', 'profiles', 'desktop');
  const info = await lstat(profile).catch(() => null);
  if (info === null) throw new CliError('INSTALL_PRECONDITION_FAILED', 'DSH desktop profile missing');
  if (!(await pnpm.ready())) throw new CliError('INSTALL_PRECONDITION_FAILED', `DSH desktop app not found at ${DSH_APP}`);
  const packageJson = join(profile, 'package.json');
  const original = await readOptional(packageJson);
  if (present(parseManifest(original))) throw new CliError('INSTALL_PRECONDITION_FAILED', `${DSH_PACKAGE} already in the DSH profile`);
  const link = join(profile, 'node_modules', DSH_PACKAGE);
  if (await pathExists(link)) throw new CliError('INSTALL_PRECONDITION_FAILED', `already exists: ${link}`);
  const patchPath = join(profile, 'cordis.patch.yml');
  const patch = await readOptional(patchPath);
  if (patch !== null && mentionsId(patch.bytes.toString('utf8'), DSH_ENTRY_ID)) {
    throw new CliError('INSTALL_PRECONDITION_FAILED', `${patchPath} still names ${DSH_ENTRY_ID} (for example the plugin page's on/off switch row); remove that entry, then install`);
  }
  const target = join(bundleDir, DSH_PLUGIN_DIR);
  const pnpmLock = join(profile, 'pnpm-lock.yaml');
  return Object.freeze({
    profile, lockPath: join(profile, 'package.json.lock'), patchPath, link, target, spec: `link:${target}`,
    packageJson: Object.freeze({ path: packageJson, original }), pnpmLock: Object.freeze({ path: pnpmLock, original: await readOptional(pnpmLock) }),
  });
}

export function describeDsh(plan: DshPlan): string[] {
  return [
    `in ${plan.profile} run DSH pnpm add ${plan.spec} --save-exact, then append ${DSH_PACKAGE} to dsh.profile.bundles`,
    'restart DSH once afterwards so it loads the bundle',
  ];
}

const shaOf = (state: FileState) => (state === null ? null : sha256(state.bytes));

async function snapshot(context: StepContext, path: string, state: FileState): Promise<FileSnapshot> {
  return Object.freeze({
    path, created: state === null, backup: state === null ? null : await context.backup(path, state.bytes),
    mode: state?.mode ?? 0o600, beforeSha: shaOf(state), afterSha: null,
  });
}

export async function applyDsh(plan: DshPlan, context: StepContext, pnpm: DshPnpm): Promise<void> {
  await withLockFile(plan.lockPath, async () => {
    const [packageJson, pnpmLock] = [await readOptional(plan.packageJson.path), await readOptional(plan.pnpmLock.path)];
    if (shaOf(packageJson) !== shaOf(plan.packageJson.original) || shaOf(pnpmLock) !== shaOf(plan.pnpmLock.original)) {
      throw new CliError('INSTALL_FAILED', 'DSH profile changed during install');
    }
    const record: DshRecord = Object.freeze({
      kind: 'dsh-bundle', lockPath: plan.lockPath, patchPath: plan.patchPath, packageName: DSH_PACKAGE, link: plan.link, target: plan.target,
      packageJson: await snapshot(context, plan.packageJson.path, packageJson), pnpmLock: await snapshot(context, plan.pnpmLock.path, pnpmLock),
    });
    await context.journal(record);
    // afterSha is recorded on failure too: the rollback then sees what this run left and restores the backups exactly.
    try {
      await pnpm.run(plan.profile, ['add', plan.spec, '--save-exact']);
      const added = parseManifest(await readOptional(plan.packageJson.path));
      if (!Object.hasOwn(added.dependencies ?? {}, DSH_PACKAGE)) throw new CliError('INSTALL_FAILED', `pnpm did not add ${DSH_PACKAGE}`);
      await writeBundles(plan.packageJson.path, added, [...bundlesOf(added), DSH_PACKAGE]);
    } finally {
      await context.amend(Object.freeze({
        ...record,
        packageJson: Object.freeze({ ...record.packageJson, afterSha: shaOf(await readOptional(plan.packageJson.path)) }),
        pnpmLock: Object.freeze({ ...record.pnpmLock, afterSha: shaOf(await readOptional(plan.pnpmLock.path)) }),
      }));
    }
  });
}

async function restoreBoth(record: DshRecord): Promise<void> {
  await restoreExact(record.packageJson);
  await restoreExact(record.pnpmLock);
}

// DSH removeBundle order: out of dsh.profile.bundles first, then pnpm remove (which settles pnpm's node_modules state files).
// When nobody touched the two files since install, the backups then put back their exact bytes (same content, same pnpm state).
// A record without afterSha (install killed before recording) proves nothing untouched, so it never gets the backups back.
async function revertPackage(record: DshRecord, pnpm: DshPnpm): Promise<RevertOutcome> {
  const [packageJson, pnpmLock] = [await readOptional(record.packageJson.path), await readOptional(record.pnpmLock.path)];
  const at = (side: 'beforeSha' | 'afterSha') =>
    shaOf(packageJson) === record.packageJson[side] && shaOf(pnpmLock) === record.pnpmLock[side];
  const exact = `${record.packageJson.path}, ${record.pnpmLock.path}: restored exactly`;
  if (at('beforeSha')) return done(`${record.packageJson.path}: unchanged by install`);
  const manifest = packageJson === null ? {} : parseManifest(packageJson);
  if (!present(manifest)) return done(`${DSH_PACKAGE} already removed from DSH profile`);
  const untouched = record.packageJson.afterSha !== null && at('afterSha');
  const linked = Object.hasOwn(manifest.dependencies ?? {}, DSH_PACKAGE);
  if (linked && !(await pnpm.ready())) {
    if (!untouched) return conflict(`DSH app not found to run pnpm remove ${DSH_PACKAGE}; remove it in the DSH plugin page, then rerun`);
    await restoreBoth(record);
    return done(`${exact} (DSH app not found; DSH's next pnpm run settles node_modules)`);
  }
  if (bundlesOf(manifest).includes(DSH_PACKAGE)) {
    await writeBundles(record.packageJson.path, manifest, bundlesOf(manifest).filter(name => name !== DSH_PACKAGE));
  }
  if (linked) await pnpm.run(dirname(record.packageJson.path), ['remove', DSH_PACKAGE]);
  if (untouched) { await restoreBoth(record); return done(`${DSH_PACKAGE}: removed with DSH pnpm; ${exact}`); }
  return done(`${DSH_PACKAGE}: removed with DSH pnpm, later profile changes kept`);
}

const entryAt = (path: string) => lstat(path).catch(() => null);

// pnpm remove leaves a link: dependency's symlink in place under the desktop profile's nodeLinker: hoisted, and pnpm writes that
// symlink relative to the real node_modules directory (~/.dsh may itself be a symlink). So the revert ends only once nothing is
// left at the link path: ms's own link is removed, anything else there is kept as a conflict.
async function removeLink(record: DshRecord): Promise<RevertOutcome | null> {
  const info = await entryAt(record.link);
  if (info === null) return null;
  const ours = info.isSymbolicLink() && resolve(await realpath(dirname(record.link)), await readlink(record.link)) === record.target;
  if (!ours) return conflict(`${record.link} is not ms's link to ${record.target}; kept, remove it and rerun`);
  await rm(record.link).catch(() => undefined);
  if ((await entryAt(record.link)) !== null) return conflict(`${record.link}: ms's link could not be removed; remove it and rerun`);
  return done(`${record.link}: removed`);
}

const joined = (first: RevertOutcome, next: RevertOutcome | null): RevertOutcome =>
  (next === null ? first : Object.freeze({ ok: next.ok, note: `${first.note}; ${next.note}` }));

async function cleanOverrides(record: DshRecord): Promise<RevertOutcome | null> {
  const patch = await readOptional(record.patchPath);
  if (patch === null) return null;
  const result = removeOverrideRows(patch.bytes.toString('utf8'), DSH_ENTRY_ID);
  if (result.conflict) return conflict(`${record.patchPath}: a row other than the plugin page's on/off switch names ${DSH_ENTRY_ID}; kept, remove it and rerun`);
  if (result.text === null) return null;
  await replaceFile(record.patchPath, result.text, patch.mode);
  return done(`${record.patchPath}: removed the plugin page's ${DSH_ENTRY_ID} switch row`);
}

export async function revertDsh(record: DshRecord, pnpm: DshPnpm): Promise<RevertOutcome> {
  try {
    return await withLockFile(record.lockPath, async () => {
      const packageOutcome = await revertPackage(record, pnpm);
      if (!packageOutcome.ok) return packageOutcome;
      const linkOutcome = joined(packageOutcome, await removeLink(record));
      if (!linkOutcome.ok) return linkOutcome;
      return joined(linkOutcome, await cleanOverrides(record));
    });
  } catch (error) {
    if (error instanceof CliError) return conflict(`${record.packageJson.path}: ${error.detail ?? error.code}`);
    throw error;
  }
}
