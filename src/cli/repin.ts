// INPUT: ms paths, the install manifest, freshly discovered pins, the Claude plugin generator and an msd reload call.
// OUTPUT: planRepin (read-only diff), describeRepin and applyRepin (plugin regeneration if Python moved, config.json python/wrapper pins, msd reload/restart).
// POS: Refreshes the Python (and wrapper) pins after updates without reinstalling; Claude updates need no repin (code signature); never automatic.
import { readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { hashTree, type PluginGenerator } from './claude-marketplace-step.ts';
import { CliError } from './errors.ts';
import { replaceFile } from './fs-ops.ts';
import { writeManifest, type InstallManifest, type InstallRecord } from './manifest.ts';
import type { MsPaths } from './paths.ts';
import type { BinaryPin, PinSet } from './pins.ts';
import { loadManifest } from './uninstall.ts';

export type RepinDeps = Readonly<{
  paths: MsPaths;
  now: () => string;
  discoverPins: () => Promise<PinSet>;
  generate: PluginGenerator;
  reload: () => Promise<unknown>;
  restart: () => Promise<boolean>;
}>;
type TreeRecord = Extract<InstallRecord, { kind: 'tree' }>;
export type RepinPlan = Readonly<{
  manifest: InstallManifest; config: Record<string, unknown>; pins: PinSet; changes: readonly string[]; plugin: TreeRecord | null;
}>;

function configPath(paths: MsPaths): string { return join(paths.root, 'config.json'); }

function describePins(label: string, before: unknown, after: readonly BinaryPin[]): string[] {
  if (isDeepStrictEqual(before, after)) return [];
  const show = (pins: readonly BinaryPin[]) => (pins.length ? pins.map(pin => `${pin.path} (${pin.sha256.slice(0, 12)})`).join(', ') : '(none)');
  return [`${label}: ${Array.isArray(before) ? show(before as BinaryPin[]) : '(invalid)'} → ${show(after)}`];
}

function diff(config: Record<string, unknown>, pins: PinSet): string[] {
  const claude = (config.claude ?? {}) as Record<string, unknown>;
  const single = (value: unknown) => (value === null || value === undefined ? [] : [value]);
  return [
    ...describePins('python', single(config.python), [pins.python]),
    ...describePins('wrapperPins', claude.wrapperPins, pins.claude.wrapperPins),
  ];
}

export async function planRepin(deps: RepinDeps): Promise<RepinPlan> {
  const manifest = await loadManifest(deps.paths);
  if (manifest.state !== 'installed') throw new CliError('NOT_INSTALLED', `manifest state ${manifest.state}`);
  let config: Record<string, unknown>;
  try { config = JSON.parse(await readFile(configPath(deps.paths), 'utf8')) as Record<string, unknown>; } catch {
    throw new CliError('MANIFEST_INVALID', 'config.json unreadable');
  }
  if (config.schemaVersion !== 4) throw new CliError('MANIFEST_INVALID', 'config.json is not schemaVersion 4; run ms uninstall, then ms install');
  const pins = await deps.discoverPins();
  const pythonMoved = (config.python as BinaryPin | undefined)?.path !== pins.python.path;
  const plugin = pythonMoved ? (manifest.records.find(record => record.kind === 'tree') ?? null) as TreeRecord | null : null;
  return Object.freeze({ manifest, config, pins, changes: diff(config, pins), plugin });
}

export function describeRepin(plan: RepinPlan): string {
  if (plan.changes.length === 0) return 'ms repin: pins unchanged (nothing written)';
  return [
    'ms repin plan (dry run, nothing written):',
    ...plan.changes.map(line => `  ${line}`),
    ...(plan.plugin ? [`  regenerate ${plan.plugin.path} with the new Python path`] : []),
    '  rewrite config.json python/claude keys (other keys kept), then ask msd to reload (restart its LaunchAgent if msd says so)',
  ].join('\n');
}

async function regeneratePlugin(plan: RepinPlan, deps: RepinDeps, plugin: TreeRecord): Promise<InstallManifest> {
  if (!isDeepStrictEqual(await hashTree(plugin.path), plugin.files)) throw new CliError('REPIN_CONFLICT', `${plugin.path} changed after install`);
  const parked = join(deps.paths.backups, `repin-${deps.now().replace(/[^0-9]/g, '')}-ms`);
  await rename(plugin.path, parked);
  try {
    await deps.generate({ directory: plugin.path, root: deps.paths.root, pythonPath: plan.pins.python.path });
  } catch (error) {
    await rm(plugin.path, { recursive: true, force: true });
    await rename(parked, plugin.path);
    throw new CliError('REPIN_FAILED', error instanceof CliError ? error.code : 'plugin generation failed');
  }
  const updated = Object.freeze({ ...plugin, files: await hashTree(plugin.path) });
  const manifest = Object.freeze({ ...plan.manifest, records: plan.manifest.records.map(record => (record === plugin ? updated : record)) });
  await writeManifest(deps.paths.manifest, manifest);
  await rm(parked, { recursive: true, force: true });
  return manifest;
}

export async function applyRepin(plan: RepinPlan, deps: RepinDeps): Promise<string> {
  if (plan.changes.length === 0) return describeRepin(plan);
  if (plan.plugin) await regeneratePlugin(plan, deps, plan.plugin);
  const config = { ...plan.config, python: plan.pins.python, claude: plan.pins.claude };
  await replaceFile(configPath(deps.paths), `${JSON.stringify(config, null, 2)}\n`, 0o600);
  const lines = ['ms repin: pins updated', ...plan.changes.map(line => `  ${line}`)];
  if (plan.plugin) lines.push(`  regenerated ${plan.plugin.path}; open Claude sessions need /reload-plugins`);
  let reloaded: unknown;
  try { reloaded = await deps.reload(); } catch (error) {
    if (!(error instanceof CliError) || error.code !== 'DAEMON_UNAVAILABLE') throw error;
    return [...lines, 'msd not running; new pins apply at next start'].join('\n');
  }
  const restartRequired = (reloaded as { restartRequired?: unknown } | null)?.restartRequired;
  if (typeof restartRequired !== 'boolean') throw new CliError('DAEMON_PROTOCOL_INVALID');
  if (!restartRequired) return [...lines, 'msd reloaded config.json'].join('\n');
  const restarted = await deps.restart();
  return [...lines, restarted ? 'msd restarted (Python pin changed)' : 'msd not loaded; new pins apply at next start'].join('\n');
}
