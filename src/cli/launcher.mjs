// INPUT: ms argv, this package's files, the running Node's path, version, platform and arch, HOME, the temp dir and the install ledger.
// OUTPUT: runLauncher → exit code; install and upgrade stage the package in a private temp dir, other commands run the installed bundle.
// POS: The npm bin's logic, in plain JavaScript: Node does not strip TypeScript types under node_modules.
import { spawn } from 'node:child_process';
import { constants, rmSync } from 'node:fs';
import { cp, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { constants as os } from 'node:os';
import { join, sep } from 'node:path';

const ROOT = ['Library', 'Application Support', 'agent-message-switchboard'];
const SUPPORTED_PLATFORM = 'darwin arm64';
const HELP = [
  'usage: ms <command>',
  '  install [--dry-run] [--harness claude-code|dsh|codex]   install Agent Message Switchboard (run with --dry-run first)',
  '  --version                                               print this package\'s version and the installed one',
  'After ms install, ms help lists every command.',
].join('\n');

const readJson = async path => JSON.parse(await readFile(path, 'utf8'));

export function nodeSupported(version) {
  const [major, minor] = version.split('.').map(Number);
  return major === 24 && minor >= 16;
}

async function installedBundle(home) {
  const manifest = await readJson(join(home, ...ROOT, 'install', 'manifest.json')).catch(() => null);
  const path = manifest?.bundle?.path;
  if (typeof path !== 'string') return null;
  return { path, version: await readJson(join(path, 'package.json')).then(pkg => pkg.version, () => null) };
}

// Defence in depth: the ledger names the bundle, but only a Node and CLI whose realpaths lie inside <root>/bundles/ are run.
async function insideBundles(home, files) {
  const root = await realpath(join(home, ...ROOT)).catch(() => null);
  const real = await Promise.all(files.map(file => realpath(file).catch(() => null)));
  return root !== null && real.every(path => path !== null && path.startsWith(join(root, 'bundles') + sep));
}

// Runs a child with this terminal; SIGINT and SIGTERM sent to ms reach it too, and its exit code (or 128 + signal) is returned.
export function spawnInherit(command, args) {
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: 'inherit' });
    const forward = signal => child.kill(signal);
    const settle = code => { process.off('SIGINT', forward); process.off('SIGTERM', forward); resolve(code); };
    process.on('SIGINT', forward); process.on('SIGTERM', forward);
    child.once('error', () => settle(127));
    child.once('exit', (code, signal) => settle(code ?? 128 + (os.signals[signal] ?? 0)));
  });
}

// What install reads from the package: its two manifests, src/, the DSH plugin and the runtime (non-dev) packages, nested ones
// travelling with their parent; an optional package npm did not install is simply absent.
async function copyPackage(from, to) {
  const lock = (await readJson(join(from, 'npm-shrinkwrap.json'))).packages ?? {};
  const modules = Object.keys(lock).filter(key => key.startsWith('node_modules/') && lock[key].dev !== true
    && !key.slice('node_modules/'.length).includes('/node_modules/'));
  for (const name of ['package.json', 'npm-shrinkwrap.json', 'src', join('plugins', 'ms-dsh'), ...modules]) {
    await cp(join(from, name), join(to, name), { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
      .catch(error => { if (!(modules.includes(name) && error.code === 'ENOENT')) throw error; });
  }
}

async function unsafeReason(dir, home) {
  const real = await realpath(home).catch(() => home);
  if (dir.split(sep).includes('node_modules')) return 'is under a node_modules directory';
  return dir === real || dir.startsWith(real + sep) ? 'is under HOME' : null;
}

async function stagedRun(deps) {
  const stage = await mkdtemp(join(deps.tmpdir, 'ms-stage-'));
  const abort = signal => { rmSync(stage, { recursive: true, force: true }); process.exit(128 + os.signals[signal]); };
  const watch = on => ['SIGINT', 'SIGTERM'].forEach(signal => (on ? process.once(signal, abort) : process.off(signal, abort)));
  watch(true);
  try {
    const dir = await realpath(stage);
    const reason = await unsafeReason(dir, deps.home);
    if (reason !== null) { deps.err(`ms: MS_STAGING_UNSAFE (${dir} ${reason}; set TMPDIR to a private directory outside HOME)`); return 5; }
    await copyPackage(deps.packageRoot, dir);
    watch(false);
    return await (deps.run ?? spawnInherit)(deps.execPath, [join(dir, 'src', 'cli', 'entry.ts'), ...deps.argv]);
  } catch (error) {
    deps.err(`ms: MS_STAGING_FAILED (${error?.code ?? 'error'} while copying the package to ${stage})`);
    return 5;
  } finally {
    watch(false);
    await rm(stage, { recursive: true, force: true }).catch(() => deps.err(`ms: warning: could not remove the staging copy ${stage}`));
  }
}

export async function runLauncher(deps) {
  const version = (await readJson(join(deps.packageRoot, 'package.json'))).version;
  const [command] = deps.argv;
  const platform = `${deps.platform} ${deps.arch}`;
  if ((command === 'install' || command === 'upgrade') && platform !== SUPPORTED_PLATFORM) {
    deps.err(`ms: MS_PLATFORM_UNSUPPORTED (this version supports only macOS on Apple Silicon, ${SUPPORTED_PLATFORM}; this is ${platform})`);
    return 5;
  }
  if (command === 'install' || command === 'upgrade') {
    if (nodeSupported(deps.nodeVersion)) return stagedRun(deps);
    deps.err(`ms: MS_NODE_UNSUPPORTED (ms needs Node 24.16 or a later 24.x, this is Node ${deps.nodeVersion}; install Node 24 LTS, then rerun ms ${command})`);
    return 5;
  }
  const installed = await installedBundle(deps.home);
  if (command === '--version') { deps.out(`ms ${version}`); deps.out(`installed: ${installed?.version ?? 'none'}`); return 0; }
  if (installed === null) {
    if (command === undefined || command === 'help' || command === '--help') { deps.out(HELP); return 0; }
    deps.err('ms: NOT_INSTALLED (run `ms install`)');
    return 5;
  }
  const node = join(installed.path, 'runtime', 'node');
  const entry = join(installed.path, 'src', 'cli', 'entry.ts');
  if (!(await insideBundles(deps.home, [node, entry]))) {
    deps.err(`ms: MS_BUNDLE_OUTSIDE_ROOT (the install ledger names ${installed.path} whose runtime/node or src/cli/entry.ts does not resolve inside ${join(deps.home, ...ROOT, 'bundles')}; not running it)`);
    return 5;
  }
  if (installed.version !== version) {
    deps.err(`ms: installed ${installed.version} differs from this package's ${version}; running the installed one (ms upgrade switches to ${version})`);
  }
  return (deps.run ?? spawnInherit)(node, [entry, ...deps.argv]);
}
