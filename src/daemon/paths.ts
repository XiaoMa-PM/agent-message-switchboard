// INPUT: An msd root directory (default under the user's Application Support).
// OUTPUT: The fixed run-directory layout shared by msd, the ms CLI and plugins (run/letter-turns holds the act letter-turn
//         markers, one per Claude messaging socket), and longSocketPath, the guard for the two sockets msd and its broker bind.
// POS: Path contract only; creates nothing and checks no permissions.
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_ROOT = join(homedir(), 'Library', 'Application Support', 'agent-message-switchboard');
export type RunPaths = Readonly<{ config: string; state: string; run: string; native: string; broker: string; brokerSocket: string;
  control: string; client: string; entry: string; letterTurns: string }>;
// macOS's sun_path holds 104 bytes including the terminating NUL, so a socket path msd or its broker binds may use 103 UTF-8 bytes.
export const MAX_SOCKET_PATH_BYTES = 103;
export const SOCKET_PATH_TOO_LONG = 'MS_SOCKET_PATH_TOO_LONG';

export function runPaths(root: string): RunPaths {
  const run = join(root, 'run');
  const native = join(run, 'native');
  return Object.freeze({ config: join(root, 'config.json'), state: join(root, 'state'), run, native, broker: join(run, 'broker'),
    brokerSocket: join(run, 'broker', 'broker.sock'), control: join(run, 'msd.sock'), client: join(run, 'claude-client.json'), entry: join(native, 'runtime_entry.py'),
    letterTurns: join(run, 'letter-turns') });
}

// The first socket under root that macOS cannot bind (msd's control socket, then the broker's), or null when both fit.
export function longSocketPath(root: string): Readonly<{ path: string; bytes: number }> | null {
  const paths = runPaths(root);
  for (const path of [paths.control, paths.brokerSocket]) {
    const bytes = Buffer.byteLength(path, 'utf8');
    if (bytes > MAX_SOCKET_PATH_BYTES) return Object.freeze({ path, bytes });
  }
  return null;
}
