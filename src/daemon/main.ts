// INPUT: Command-line `--root <dir>` (optional) and process signals.
// OUTPUT: One foreground msd process with a single ready line and orderly SIGTERM/SIGINT shutdown.
// POS: msd executable entry for LaunchAgent or manual runs; no install, retry or self-restart.
import { isAbsolute } from 'node:path';
import { startMsd } from './msd.ts';
import { DEFAULT_ROOT } from './paths.ts';

function root(args: readonly string[]): string {
  if (args.length === 0) return DEFAULT_ROOT;
  if (args.length === 2 && args[0] === '--root' && isAbsolute(args[1])) return args[1];
  throw new Error('USAGE: msd [--root <absolute dir>]');
}

try {
  const daemon = await startMsd({ root: root(process.argv.slice(2)) });
  const stop = (code: number) => { void daemon.close().finally(() => process.exit(code)); };
  process.once('SIGTERM', () => stop(0));
  process.once('SIGINT', () => stop(0));
  void daemon.whenBrokerClosed.then(() => stop(1), () => stop(1));
  console.info('MSD_READY ' + JSON.stringify({ control: daemon.paths.control }));
} catch (error) {
  console.error('MSD_START_FAILED ' + (error instanceof Error && /^[A-Z][A-Z0-9_]+/.test(error.message)
    ? error.message.split(/\s/)[0] : 'INTERNAL_ERROR'));
  process.exitCode = 1;
}
