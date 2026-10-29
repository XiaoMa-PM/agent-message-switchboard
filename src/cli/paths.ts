// INPUT: The invoking user's HOME directory.
// OUTPUT: resolvePaths → frozen ms private-root, socket, bundle, manifest, LaunchAgent and fallback-launcher locations (the ms
//         command itself comes from npm; <root>/bin/ms is off PATH, for when the npm package is gone).
// POS: Single source of on-disk locations shared by install, daemon and control commands.
import { join } from 'node:path';

export const LAUNCH_AGENT_LABEL = 'local.agent-message-switchboard.msd';

export type MsPaths = Readonly<{
  home: string;
  root: string;
  socket: string;
  bundles: string;
  installDir: string;
  manifest: string;
  backups: string;
  logs: string;
  launchAgent: string;
  fallback: string;
}>;

export function resolvePaths(home: string): MsPaths {
  if (!home.startsWith('/')) throw new Error('HOME_INVALID');
  const root = join(home, 'Library', 'Application Support', 'agent-message-switchboard');
  return Object.freeze({
    home,
    root,
    socket: join(root, 'run', 'msd.sock'),
    bundles: join(root, 'bundles'),
    installDir: join(root, 'install'),
    manifest: join(root, 'install', 'manifest.json'),
    backups: join(root, 'install', 'backups'),
    logs: join(root, 'logs'),
    launchAgent: join(home, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`),
    fallback: join(root, 'bin', 'ms'),
  });
}
