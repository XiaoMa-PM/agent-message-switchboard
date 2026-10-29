// INPUT: Private temp directories only.
// OUTPUT: makeHome/makeSource fixtures, snapshotTree, fake launchctl, fake dsh pnpm, claude and codex CLIs, interruptLedger.
// POS: Shared test fixtures for install/uninstall round trips; never touches the real HOME.
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import type { ClaudeCli } from '../../src/cli/claude-marketplace-step.ts';
import { prepareDailyCodexMarketplace } from '../../src/adapters/codex/plugin.ts';
import { planCodexPluginStep, type CodexCli } from '../../src/cli/codex-plugin-step.ts';
import type { DshPnpm } from '../../src/cli/dsh-bundle.ts';
import { CliError } from '../../src/cli/errors.ts';
import type { Launchctl } from '../../src/cli/launchd.ts';
import type { ClaudeStep, InstallEnv } from '../../src/cli/install.ts';
import { parseManifest, writeManifest, type InstallRecord } from '../../src/cli/manifest.ts';
import type { PinSet } from '../../src/cli/pins.ts';
import { resolvePaths } from '../../src/cli/paths.ts';

export const DESKTOP_PATCH = '- id: ui-theme\n  config:\n    theme: dark\n- id: agent-loop\n  config: {}\n';
export const PROFILE_PACKAGE = '{"name":"dsh-profile-desktop","dependencies":{"other-bundle":"link:/opt/other-bundle"},"dsh":{"profile":{"bundles":["other-bundle"]}}}\n';
// ~/.dsh is a symlink to a directory one level deeper, as on the real machine, so a relative link read from the lexical ~/.dsh
// path lands somewhere other than the target it has from the real path.
const DSH_HOME = 'work/.dsh-home';
const DESKTOP = `${DSH_HOME}/profiles/desktop`;

function lockText(dependencies: Record<string, string>): string {
  const entries = Object.entries(dependencies).sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, spec]) => `      ${name}:\n        specifier: ${spec}\n        version: ${spec}\n`);
  return `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n${entries.join('')}`;
}

async function put(root: string, files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
}

export async function makeHome(): Promise<string> {
  // Short like a real /Users/<name>: under /private/tmp the broker socket path stays within macOS's 103 bytes.
  const home = await realpath(await mkdtemp('/tmp/msh-'));
  await mkdir(join(home, 'Library', 'Application Support'), { recursive: true });
  await put(home, {
    [`${DESKTOP}/cordis.patch.yml`]: DESKTOP_PATCH,
    [`${DESKTOP}/package.json`]: PROFILE_PACKAGE,
    [`${DESKTOP}/pnpm-lock.yaml`]: lockText({ 'other-bundle': 'link:/opt/other-bundle' }),
    [`${DSH_HOME}/profiles/web/cordis.patch.yml`]: '[]\n',
    [`${DSH_HOME}/cordis.patch.yml`]: '- id: relay-codex-host\n  config: {}\n',
    '.claude/settings.json': '{\n  "model": "opus",\n  "enabledPlugins": {\n    "other@m": true\n  }\n}\n',
  });
  await chmod(join(home, `${DESKTOP}/cordis.patch.yml`), 0o600);
  await chmod(join(home, `${DESKTOP}/package.json`), 0o600);
  await mkdir(join(home, `${DESKTOP}/node_modules`));
  await symlink('/opt/other-bundle', join(home, `${DESKTOP}/node_modules/other-bundle`));
  await symlink(join(home, DSH_HOME), join(home, '.dsh'));
  return home;
}

export type FakePnpm = { pnpm: DshPnpm; calls: string[][]; bundlesAt: unknown[][]; fail: Set<string> };

// Plays DSH's pnpm: add link:<dir> / remove <name> rewrite package.json and pnpm-lock.yaml; bundlesAt records each call's bundles.
// As under DSH's hoisted nodeLinker, remove leaves the link symlink; a verb in `fail` exits 1 (a failing add after package.json).
export function fakeDshPnpm(): FakePnpm {
  const calls: string[][] = [];
  const bundlesAt: unknown[][] = [];
  const fail = new Set<string>();
  const run = async (cwd: string, args: readonly string[]) => {
    calls.push([...args]);
    const manifest = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'));
    bundlesAt.push([...(manifest.dsh?.profile?.bundles ?? [])]);
    const dependencies: Record<string, string> = { ...manifest.dependencies };
    const [verb, operand] = args;
    const name = verb === 'add' ? JSON.parse(await readFile(join(operand.slice('link:'.length), 'package.json'), 'utf8')).name : operand;
    if (verb === 'add') dependencies[name] = operand;
    else delete dependencies[name];
    await writeFile(join(cwd, 'package.json'), `${JSON.stringify({ ...manifest, dependencies }, null, 2)}\n`);
    if (fail.has(verb)) throw new CliError('DSH_PNPM_FAILED', `${verb} exit 1`);
    await writeFile(join(cwd, 'pnpm-lock.yaml'), lockText(dependencies));
    const link = join(cwd, 'node_modules', name);
    if (verb === 'add') await symlink(relative(await realpath(dirname(link)), operand.slice('link:'.length)), link);
  };
  return { calls, bundlesAt, fail, pnpm: { ready: async () => true, run } };
}

export async function makeSource(): Promise<{ root: string; node: string }> {
  const root = await mkdtemp('/tmp/ms-src-');
  await put(root, {
    'package.json': '{"type":"module"}\n',
    'npm-shrinkwrap.json': JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { prod: '1' } }, 'node_modules/prod': {}, 'node_modules/dev': { dev: true } } }),
    'node_modules/prod/index.js': 'export default 1;\n',
    'node_modules/dev/index.js': 'dev\n',
    'src/cli/entry.ts': '// cli\n',
    'src/daemon/main.ts': '// daemon\n',
    'plugins/ms-claude/.claude-plugin/plugin.json': '{"name":"ms"}\n',
    'plugins/ms-dsh/index.mjs': 'export const name = "ms";\n',
    'plugins/ms-dsh/package.json': '{"name":"agent-message-switchboard-dsh","version":"0.1.0"}\n',
    'tests/ignored.test.ts': 'x\n',
    'fake-node': '#!/bin/sh\n[ "$1" = --version ] && echo v24.16.0\nexit 0\n',
  });
  await chmod(join(root, 'fake-node'), 0o755);
  return { root, node: join(root, 'fake-node') };
}

export type Snapshot = Record<string, string>;

export async function snapshotTree(root: string, relative = ''): Promise<Snapshot> {
  const result: Snapshot = {};
  const path = join(root, relative);
  const info = await lstat(path);
  const mode = (info.mode & 0o7777).toString(8);
  if (info.isSymbolicLink()) { result[relative] = `link ${await readlink(path)}`; return result; }
  if (info.isFile()) {
    result[relative] = `file ${mode} ${createHash('sha256').update(await readFile(path)).digest('hex')}`;
    return result;
  }
  result[relative || '.'] = `dir ${mode}`;
  for (const name of (await readdir(path)).sort()) Object.assign(result, await snapshotTree(root, join(relative, name)));
  return result;
}

export function recordingLaunchctl(): { launchctl: Launchctl; calls: string[][] } {
  const calls: string[][] = [];
  return { calls, launchctl: async args => { calls.push([...args]); return { code: 113, stdout: '' }; } };
}

export const FAKE_PINS: PinSet = Object.freeze({
  python: { path: '/opt/python/Python.app/Contents/MacOS/Python', sha256: 'a'.repeat(64) },
  claude: { wrapperPins: [] },
});

export const STUB_CLAUDE: ClaudeStep = Object.freeze({ lines: ['claude step (stub)'], apply: async () => undefined });

// The ledger an install killed (Ctrl-C) between journaling `kind` and recording what the host command wrote leaves behind:
// state installing, and no afterSha on that record's file snapshots. Returns the record as it now stands.
export async function interruptLedger(manifestPath: string, kind: InstallRecord['kind']): Promise<InstallRecord> {
  const manifest = parseManifest(await readFile(manifestPath, 'utf8'));
  const cleared = (value: unknown) => (value !== null && typeof value === 'object' && 'afterSha' in value ? { ...value, afterSha: null } : value);
  const records = manifest.records.map(record => (record.kind === kind
    ? Object.fromEntries(Object.entries(record).map(([key, value]) => [key, cleared(value)])) as InstallRecord : record));
  await writeManifest(manifestPath, { ...manifest, state: 'installing', records });
  return records.find(record => record.kind === kind)!;
}

export type FakeClaude = { cli: ClaudeCli; calls: string[][]; fail: Set<string>; ready: { value: boolean } };

async function readJson(path: string): Promise<Record<string, any> | null> {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

async function writeJson(path: string, value: unknown, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode });
}

// Plays `claude plugin …` like the real CLI: add declares the marketplace, install enables, records and caches the plugin;
// uninstall/remove leave empty maps and mark the cache copy .orphaned_at. A verb in `fail` exits 1 after its own writes.
export function fakeClaudeCli(home: string): FakeClaude {
  const calls: string[][] = [];
  const fail = new Set<string>();
  const ready = { value: true };
  const claude = join(home, '.claude');
  const settingsPath = join(claude, 'settings.json');
  const knownPath = join(claude, 'plugins', 'known_marketplaces.json');
  const installedPath = join(claude, 'plugins', 'installed_plugins.json');
  const run = async (args: readonly string[]) => {
    calls.push([...args]);
    const settings = (await readJson(settingsPath)) ?? {};
    const known = (await readJson(knownPath)) ?? {};
    const installed = (await readJson(installedPath)) ?? { version: 2, plugins: {} };
    const verb = args[1] === 'marketplace' ? `marketplace ${args[2]}` : args[1];
    if (verb === 'marketplace add') {
      const name = JSON.parse(await readFile(join(args[3], '.claude-plugin', 'marketplace.json'), 'utf8')).name;
      const source = { source: 'directory', path: args[3] };
      settings.extraKnownMarketplaces = { ...settings.extraKnownMarketplaces, [name]: { source } };
      known[name] = { source, installLocation: args[3], lastUpdated: '2026-10-22T00:00:00.000Z' };
      await mkdir(join(claude, 'plugins', 'marketplaces'), { recursive: true });
    } else if (verb === 'install') {
      const [plugin, market] = args[2].split('@');
      const cache = join(claude, 'plugins', 'cache', market, plugin, '0.1.0');
      settings.enabledPlugins = { ...settings.enabledPlugins, [args[2]]: true };
      installed.plugins[args[2]] = [{ scope: 'user', installPath: cache, version: '0.1.0', installedAt: 'T', lastUpdated: 'T' }];
      await mkdir(cache, { recursive: true });
      await writeFile(join(cache, 'plugin.json'), '{}\n');
    } else if (verb === 'uninstall') {
      const [plugin, market] = args[2].split('@');
      const { enabledPlugins, ...rest } = settings;
      delete enabledPlugins?.[args[2]];
      Object.keys(settings).forEach(key => delete settings[key]);
      Object.assign(settings, { enabledPlugins: enabledPlugins ?? {} }, rest);
      delete installed.plugins[args[2]];
      await writeFile(join(claude, 'plugins', 'cache', market, plugin, '0.1.0', '.orphaned_at'), 'T');
    } else if (verb === 'marketplace remove') {
      delete settings.extraKnownMarketplaces?.[args[3]];
      delete known[args[3]];
    } else throw new Error(`fake claude: ${args.join(' ')}`);
    await writeJson(settingsPath, settings, 0o600);
    await writeJson(knownPath, known, 0o644);
    if (verb !== 'marketplace add' && verb !== 'marketplace remove') await writeJson(installedPath, installed, 0o644);
    if (fail.has(verb)) throw new CliError('CLAUDE_CLI_FAILED', `${verb} exit 1`);
  };
  return { calls, fail, ready, cli: { ready: async () => ready.value, run } };
}

export type FakeCodex = { cli: CodexCli; calls: string[][]; fail: Set<string>; ready: { value: boolean } };

// Drops whole TOML table blocks (header to the next header) whose header matches, like codex's own config edits.
function dropToml(text: string, owned: (header: string) => boolean): string {
  const out: string[] = [];
  let skipping = false;
  for (const line of text.split('\n')) {
    if (/^\s*\[/.test(line)) skipping = owned(line.trim());
    if (!skipping) out.push(line);
  }
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

// Plays `codex plugin …` like the real CLI: marketplace add and plugin add append their tables and cache the plugin; remove
// drops the tables with their subtables and leaves the empty cache directories. Codex runtime directories are made on demand.
export function fakeCodexCli(home: string): FakeCodex {
  const calls: string[][] = [];
  const fail = new Set<string>();
  const ready = { value: true };
  const codex = join(home, '.codex');
  const config = join(codex, 'config.toml');
  let marketplaceDir = '';
  const run = async (args: readonly string[]) => {
    calls.push([...args]);
    await mkdir(join(codex, '.tmp', 'marketplaces'), { recursive: true });
    await mkdir(join(codex, 'tmp', 'arg0-macos'), { recursive: true });
    const text = await readFile(config, 'utf8');
    const terminated = text === '' || text.endsWith('\n') ? text : `${text}\n`;
    const verb = args[1] === 'marketplace' ? `marketplace ${args[2]}` : args[1];
    let next = text;
    if (verb === 'marketplace add') {
      marketplaceDir = args[3];
      const name = JSON.parse(await readFile(join(args[3], '.claude-plugin', 'marketplace.json'), 'utf8')).name;
      next = `${terminated}\n[marketplaces.${name}]\nsource_type = "local"\nsource = ${JSON.stringify(args[3])}\n`;
    } else if (verb === 'add') {
      const [plugin, market] = args[2].split('@');
      const version = JSON.parse(await readFile(join(marketplaceDir, 'plugins', plugin, '.codex-plugin', 'plugin.json'), 'utf8')).version;
      next = `${terminated}\n[plugins.${JSON.stringify(args[2])}]\nenabled = true\n`;
      const cache = join(codex, 'plugins', 'cache', market, plugin, version);
      await mkdir(cache, { recursive: true });
      await writeFile(join(cache, 'plugin.json'), '{}\n');
    } else if (verb === 'remove') {
      const [plugin, market] = args[2].split('@');
      next = dropToml(text, header => header.startsWith(`[plugins.${JSON.stringify(args[2])}`));
      await rm(join(codex, 'plugins', 'cache', market, plugin), { recursive: true, force: true });
    } else if (verb === 'marketplace remove') {
      next = dropToml(text, header => header === `[marketplaces.${args[3]}]`);
    } else throw new Error(`fake codex: ${args.join(' ')}`);
    await writeFile(config, next);
    if (fail.has(verb)) throw new CliError('CODEX_CLI_FAILED', `${verb} exit 1`);
  };
  return { calls, fail, ready, cli: { ready: async () => ready.value, path: async () => '/fake/codex', run } };
}

export function makeEnv(home: string, source: { root: string; node: string }, claude: ClaudeStep = STUB_CLAUDE,
  dshPnpm: DshPnpm = fakeDshPnpm().pnpm, claudeCli: ClaudeCli = fakeClaudeCli(home).cli,
  codexCli: CodexCli = fakeCodexCli(home).cli): InstallEnv {
  return {
    paths: resolvePaths(home), sourceRoot: source.root, nodePath: source.node, now: () => '2026-10-20T00:00:00.000Z',
    discoverPins: async () => FAKE_PINS, planClaude: async () => claude, dshPnpm, claudeCli, codexCli,
    planCodex: target => planCodexPluginStep({ paths: resolvePaths(home), generate: prepareDailyCodexMarketplace, codex: codexCli }, target),
  };
}
