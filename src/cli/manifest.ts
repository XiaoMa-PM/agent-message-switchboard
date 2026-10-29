// INPUT: Install records produced while applying steps, or the on-disk manifest.json text.
// OUTPUT: InstallRecord/InstallManifest types, emptyManifest, parseManifest (strict) and writeManifest (atomic, 0600).
// POS: The single journal that uninstall trusts; written after every record so a partial install stays revertible.
import { HARNESSES, type Harness } from './args.ts';
import { CliError } from './errors.ts';
import { replaceFile } from './fs-ops.ts';

export type FileSnapshot = Readonly<{
  path: string; created: boolean; backup: string | null; mode: number; beforeSha: string | null; afterSha: string | null;
}>;

export type TreeFile = Readonly<{ path: string; sha256: string }>;

// harness marks a record written by one harness step (ms uninstall/install --harness); core records have none.
export type InstallRecord = Readonly<{ harness?: Harness }> & (
  | Readonly<{ kind: 'mkdir'; path: string }>
  | Readonly<{ kind: 'create'; path: string; sha256: string }>
  | Readonly<{
    kind: 'dsh-bundle'; lockPath: string; patchPath: string; packageName: string; link: string; target: string;
    packageJson: FileSnapshot; pnpmLock: FileSnapshot;
  }>
  | Readonly<{ kind: 'tree'; path: string; captured: boolean; files: readonly TreeFile[] }>
  | Readonly<{
    kind: 'claude-plugin'; marketplace: string; pluginId: string; settings: FileSnapshot; knownMarketplaces: FileSnapshot;
    installedPlugins: FileSnapshot; absent: readonly string[];
  }>
  | Readonly<{
    kind: 'codex-plugin'; marketplace: string; pluginId: string; config: FileSnapshot; hooksState: boolean; absent: readonly string[];
  }>);

export type InstallManifest = Readonly<{
  schemaVersion: 1;
  state: 'installing' | 'installed' | 'conflict';
  createdAt: string;
  bundle: Readonly<{ path: string; digest: string; files: number }> | null;
  records: readonly InstallRecord[];
}>;

const KINDS = new Set(['mkdir', 'create', 'dsh-bundle', 'tree', 'codex-plugin', 'claude-plugin']);
const STATES = new Set(['installing', 'installed', 'conflict']);

export function emptyManifest(createdAt: string): InstallManifest {
  return Object.freeze({ schemaVersion: 1, state: 'installing', createdAt, bundle: null, records: Object.freeze([]) });
}

function absolute(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith('/');
}

function validRecord(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (!KINDS.has(record.kind as string)) return false;
  if (record.harness !== undefined && !(HARNESSES as readonly unknown[]).includes(record.harness)) return false;
  if (record.kind === 'mkdir' || record.kind === 'create') return absolute(record.path);
  if (record.kind === 'tree') return absolute(record.path) && typeof record.captured === 'boolean' && Array.isArray(record.files);
  if (record.kind === 'codex-plugin') {
    const config = record.config as Record<string, unknown> | undefined;
    return config !== undefined && absolute(config.path) && typeof record.marketplace === 'string' && typeof record.pluginId === 'string'
      && typeof record.hooksState === 'boolean' && Array.isArray(record.absent) && record.absent.every(absolute);
  }
  if (record.kind === 'claude-plugin') {
    const files = [record.settings, record.knownMarketplaces, record.installedPlugins] as Array<Record<string, unknown> | undefined>;
    return files.every(file => file !== undefined && absolute(file.path)) && typeof record.marketplace === 'string'
      && typeof record.pluginId === 'string' && Array.isArray(record.absent) && record.absent.every(absolute);
  }
  const files = [record.packageJson, record.pnpmLock] as Array<Record<string, unknown> | undefined>;
  return files.every(file => file !== undefined && absolute(file.path))
    && [record.lockPath, record.patchPath, record.link, record.target].every(absolute) && typeof record.packageName === 'string';
}

export function parseManifest(text: string): InstallManifest {
  let value: Record<string, unknown>;
  try { value = JSON.parse(text) as Record<string, unknown>; } catch { throw new CliError('MANIFEST_INVALID'); }
  if (value === null || typeof value !== 'object' || value.schemaVersion !== 1 || !STATES.has(value.state as string)
    || !Array.isArray(value.records) || !value.records.every(validRecord)) {
    throw new CliError('MANIFEST_INVALID');
  }
  return value as unknown as InstallManifest;
}

export async function writeManifest(path: string, manifest: InstallManifest): Promise<void> {
  await replaceFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
}
