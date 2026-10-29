// INPUT: An output sink, a browser opener, a promise that settles on Ctrl+C (SIGINT/SIGTERM), the snapshot reader and, for tests, the
//        server starter.
// OUTPUT: runUi → 'ms ui stopped' after printing the launch address and the stop hint; UI_START_FAILED when the server cannot start.
// POS: ms ui command flow: a foreground process only, never msd and never a LaunchAgent.
import { CliError } from '../errors.ts';
import { loadUiAssets, startUiServer } from './server.ts';

export type UiDeps = Readonly<{
  out: (text: string) => void;
  open: (url: string) => Promise<void>;
  stopped: Promise<void>;
  snapshot: () => Promise<unknown>;
  start?: typeof startUiServer;
}>;

export async function runUi(deps: UiDeps): Promise<string> {
  const start = deps.start ?? startUiServer;
  let server: Awaited<ReturnType<typeof startUiServer>>;
  try { server = await start({ assets: await loadUiAssets(), snapshot: deps.snapshot }); } catch (error) {
    throw new CliError('UI_START_FAILED', (error as NodeJS.ErrnoException).code);
  }
  deps.out(`ms ui: ${server.launchUrl}`);
  deps.out('Press Ctrl+C to stop.');
  try { await deps.open(server.launchUrl); } catch { deps.out('Could not open the browser; open the address above manually.'); }
  await deps.stopped;
  await server.close();
  return 'ms ui stopped';
}
