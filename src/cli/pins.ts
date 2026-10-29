// INPUT: PATH lookups and read-only probes of the Python interpreter on this Mac (version, sha256, codesign Developer ID check,
//        the broker's owner rule from helper-process).
// OUTPUT: discoverPins (and systemPinProbe for the real Mac) → {python (sha256, ≥3.13.14, not Developer ID signed, owned by this
//         user or root), claude:{wrapperPins: []}}; Claude binaries are not pinned.
// POS: install/repin-time pin discovery for msd config.json v2; Claude is identified by its Anthropic code signature in msd.
import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { trustedInterpreter } from '../bridge/helper-process.ts';
import { sha256File } from './bundle.ts';
import { CliError } from './errors.ts';

export type BinaryPin = Readonly<{ path: string; sha256: string }>;
export type ClaudeConfig = Readonly<{ wrapperPins: readonly BinaryPin[] }>;
export type PinSet = Readonly<{ python: BinaryPin; claude: ClaudeConfig }>;
export type PinProbe = Readonly<{
  which: (name: string) => Promise<string | null>;
  realpath: (path: string) => Promise<string>;
  isFile: (path: string) => Promise<boolean>;
  sha256: (path: string) => Promise<string>;
  pythonVersion: (path: string) => Promise<string>;
  developerIdSigned: (path: string) => Promise<boolean>;
  ownedByUserOrRoot: (path: string) => Promise<boolean>;
}>;

const PYTHON_MINIMUM = [3, 13, 14] as const;
const FRAMEWORK_BIN = /^(.*\/Python\.framework\/Versions\/[^/]+)\/bin\/python3(?:\.\d+)?$/;
// The Developer ID shape the broker checks before it reports a signer (macos_identity._developer_id, minus the code's own
// team/identifier). A Python that passes it is snapshotted without sha256, so its pin could never match.
const DEVELOPER_ID = '=anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists'
  + ' and certificate leaf[field.1.2.840.113635.100.6.1.13] exists';

function missing(detail: string): never { throw new CliError('INSTALL_PRECONDITION_FAILED', detail); }

async function pin(probe: PinProbe, path: string): Promise<BinaryPin> {
  return Object.freeze({ path, sha256: await probe.sha256(path) });
}

function atLeastMinimum(version: string): boolean {
  const parts = version.match(/^(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  if (parts === undefined) return false;
  for (const [index, minimum] of PYTHON_MINIMUM.entries()) {
    if (parts[index] !== minimum) return parts[index] > minimum;
  }
  return true;
}

async function pythonPin(probe: PinProbe): Promise<BinaryPin> {
  const found = await probe.which('python3');
  if (found === null) missing('python3 not on PATH');
  const real = await probe.realpath(found);
  const framework = real.match(FRAMEWORK_BIN);
  const interpreter = framework ? join(framework[1], 'Resources/Python.app/Contents/MacOS/Python') : real;
  if (!(await probe.isFile(interpreter))) missing('python interpreter missing');
  if (!atLeastMinimum(await probe.pythonVersion(interpreter))) missing(`python >= ${PYTHON_MINIMUM.join('.')} required`);
  if (await probe.developerIdSigned(interpreter)) {
    throw new CliError('UNSUPPORTED_PYTHON_SIGNATURE', `${interpreter} is Developer ID signed (e.g. the python.org installer); `
      + 'ms needs an ad-hoc signed Python such as Homebrew\'s first on PATH');
  }
  // msd refuses to start the broker on any other Python, so install and repin refuse it first.
  if (!(await probe.ownedByUserOrRoot(interpreter))) {
    throw new CliError('UNSUPPORTED_PYTHON_OWNER', `${interpreter} or a directory above it belongs to another user or can be changed `
      + 'by others; ms needs a Python owned by you or root first on PATH (not another account\'s Homebrew: install one for this '
      + 'account, for example with uv)');
  }
  return pin(probe, interpreter);
}

export async function discoverPins(probe: PinProbe): Promise<PinSet> {
  return Object.freeze({ python: await pythonPin(probe), claude: Object.freeze({ wrapperPins: [] }) });
}

export function systemPinProbe(pathEnv: string, codesign = '/usr/bin/codesign'): PinProbe {
  return Object.freeze({
    which: async (name: string) => {
      for (const dir of pathEnv.split(':').filter(entry => entry.startsWith('/'))) {
        if (await isExecutableFile(join(dir, name))) return join(dir, name);
      }
      return null;
    },
    realpath: (path: string) => realpath(path),
    isFile: isExecutableFile,
    sha256: (path: string) => sha256File(path),
    pythonVersion: (path: string) => new Promise<string>((resolve, reject) => {
      execFile(path, ['-I', '-S', '-c', 'import sys;print("%d.%d.%d" % sys.version_info[:3])'], { timeout: 10000 },
        (error, stdout) => (error ? reject(new CliError('INSTALL_PRECONDITION_FAILED', 'python probe failed')) : resolve(stdout.trim())));
    }),
    // codesign exits 0 when the requirement holds, 3 when it does not, 1 when the signature is ad-hoc/invalid or absent.
    developerIdSigned: (path: string) => new Promise<boolean>((resolve, reject) => {
      execFile(codesign, ['--verify', '-R', DEVELOPER_ID, '--', path], { timeout: 10000 }, error => {
        if (!error) resolve(true);
        else if (error.code === 1 || error.code === 3) resolve(false);
        else reject(new CliError('INSTALL_PRECONDITION_FAILED', 'codesign probe failed'));
      });
    }),
    ownedByUserOrRoot: async (path: string) => trustedInterpreter(path, BigInt(process.getuid!())),
  });
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && (info.mode & 0o111) !== 0;
  } catch { return false; }
}
