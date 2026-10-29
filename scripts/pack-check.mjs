// INPUT: This checkout (package.json, npm-shrinkwrap.json), npm, the registry, and on Apple Silicon macOS this Mac's Node, Python and CLIs.
// OUTPUT: Exit 0 when the npm pack tarball and a throwaway install pass the size, content and ms install --dry-run checks; else exit 1.
// POS: The packing smoke test behind `make pack-check`; needs the network; ms runs only with a throwaway HOME.
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MAX_PACKED = 2 * 1024 * 1024;
const MAX_INSTALLED = 10 * 1024 * 1024;
const BANNED_FILES = ['src/adapters/claude/metadata.ts', 'src/adapters/claude/metadata-worker.mjs'];
const SDK = '@anthropic-ai/claude-agent-sdk';

function check(ok, message) {
  if (!ok) { console.error(`pack-check: FAILED ${message}`); process.exit(1); }
  console.log(`pack-check: ok ${message}`);
}

async function walk(dir, found = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path, found);
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

const run = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', ...options });
const work = await mkdtemp(join(tmpdir(), 'ms-pack-'));
try {
  const [packed] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', work], { cwd: ROOT }));
  const names = packed.files.map(file => file.path);
  check(packed.size < MAX_PACKED, `tarball ${packed.size} bytes (< ${MAX_PACKED}), ${names.length} files`);
  check(!names.some(name => name.endsWith('AGENTS.md') || BANNED_FILES.includes(name)), 'tarball has no AGENTS.md and neither metadata file');

  const prefix = join(work, 'prefix');
  run('npm', ['install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', join(work, packed.filename)]);
  const installed = join(prefix, 'lib', 'node_modules', packed.name);
  const files = await walk(installed);
  const bytes = (await Promise.all(files.map(file => stat(file)))).reduce((total, info) => total + info.size, 0);
  check(bytes < MAX_INSTALLED, `installed package ${bytes} bytes (< ${MAX_INSTALLED}), ${files.length} files`);
  check(!files.some(file => file.includes(`${join('node_modules', '@anthropic-ai')}`)), 'no @anthropic-ai package installed');
  check(!files.some(file => BANNED_FILES.some(banned => file.endsWith(banned))), 'installed package has neither metadata file');
  for (const file of files.filter(item => /\.(?:[cm]?js|ts)$/.test(item))) {
    if ((await readFile(file, 'utf8')).includes(SDK)) check(false, `${file} names ${SDK}`);
  }
  check(true, `no installed file names ${SDK}`);

  const ms = join(prefix, 'bin', 'ms');
  const version = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')).version;
  // The private root's sockets must fit macOS's 103-byte limit, so the throwaway HOME sits directly under /tmp.
  const home = await mkdtemp('/tmp/ms-pack-home-');
  const env = { ...process.env, HOME: home };
  check(run(ms, ['--version'], { env }) === `ms ${version}\ninstalled: none\n`, `ms --version prints ms ${version}, installed: none`);
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    const plan = run(ms, ['install', '--dry-run'], { env });
    check(plan.startsWith('ms install plan (dry run, nothing written):'), 'ms install --dry-run plans from the npm install');
  } else {
    console.log(`pack-check: skipped ms install --dry-run: install supports only darwin arm64, this is ${process.platform} ${process.arch}`);
  }
  const left = await readdir(home);
  await rm(home, { recursive: true, force: true });
  check(left.length === 0, 'ms left the throwaway HOME empty');
  console.log(`pack-check: sizes packed=${packed.size} unpacked=${packed.unpackedSize} installed=${bytes}`);
} finally {
  await rm(work, { recursive: true, force: true });
}
