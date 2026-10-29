// INPUT: The private msd run directory, the install-recorded Python pin and the repository native sources.
// OUTPUT: A rebuilt 0700 runtime bundle (7 pinned modules + broker config) and the atomically written daily client config.
// POS: msd startup artifact writer; pins are self-computed digests, not independent attestation.
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BinaryPin, type ProcessSnapshot } from '../adapters/claude/peer-identity.ts';
import { type HelperConfig } from '../bridge/helper-process.ts';
import { runPaths } from './paths.ts';

export const NATIVE_FILES = Object.freeze(['macos_identity', 'ipc_frame', 'broker_identity', 'inspect_control',
  'broker_server', 'hook_client', 'runtime_entry'].map(name => name + '.py'));
const SOURCE = fileURLToPath(new URL('../bridge/native/', import.meta.url));

export type NativeBundle = Readonly<{ helper: HelperConfig; brokerConfig: Readonly<Record<string, unknown>>;
  clientConfigPath: string; brokerSocketPath: string }>;

export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid!() || (info.mode & 0o077) !== 0) {
    throw new Error('MSD_DIRECTORY_UNTRUSTED');
  }
}

export async function prepareNativeBundle(root: string, python: BinaryPin): Promise<NativeBundle> {
  const paths = runPaths(root);
  await privateDirectory(paths.run);
  await rm(paths.native, { recursive: true, force: true });
  await mkdir(paths.native, { mode: 0o700 }); await chmod(paths.native, 0o700);
  await privateDirectory(paths.broker);
  const brokerSocketPath = paths.brokerSocket;
  await rm(brokerSocketPath, { force: true });
  const codePins: BinaryPin[] = [];
  for (const name of NATIVE_FILES) {
    const bytes = await readFile(join(SOURCE, name));
    const path = join(paths.native, name);
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    codePins.push(Object.freeze({ path, sha256: createHash('sha256').update(bytes).digest('hex') }));
  }
  const brokerConfig = Object.freeze({ schemaVersion: 1, role: 'broker', codeRoot: paths.native,
    python: Object.freeze({ ...python }), codePins: Object.freeze(codePins), socketPath: brokerSocketPath });
  const configPath = join(paths.native, 'broker-config.json');
  await writeFile(configPath, JSON.stringify(brokerConfig), { flag: 'wx', mode: 0o600 });
  return Object.freeze({ helper: Object.freeze({ python: brokerConfig.python, codeRoot: paths.native,
    entryPath: paths.entry, configPath, codePins: brokerConfig.codePins }),
    brokerConfig, clientConfigPath: paths.client, brokerSocketPath });
}

export async function writeClientConfig(bundle: NativeBundle, broker: ProcessSnapshot, parent: ProcessSnapshot): Promise<void> {
  const temporary = join(dirname(bundle.clientConfigPath), `.client-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify({ ...bundle.brokerConfig, role: 'daily-client', broker, parent }),
    { flag: 'wx', mode: 0o600 });
  await rename(temporary, bundle.clientConfigPath);
}
