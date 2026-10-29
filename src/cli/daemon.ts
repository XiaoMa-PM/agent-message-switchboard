// INPUT: ms paths, an injected launchctl runner, the user's uid and control-socket timing options.
// OUTPUT: runDaemon(start|stop|status) → human status text; NOT_INSTALLED/LAUNCHD_FAILED/DAEMON_START_TIMEOUT/DAEMON_* fixed errors.
// POS: LaunchAgent lifecycle for msd; never edits the plist (install owns it) and never kills processes directly.
import { join } from 'node:path';
import { callControl } from './control-client.ts';
import { renderResult } from './format.ts';
import { CliError } from './errors.ts';
import { pathExists } from './fs-ops.ts';
import { LAUNCH_AGENT_LABEL, type MsPaths } from './paths.ts';
import { bootoutService, bootstrapService, serviceState, type Launchctl, type ServiceState } from './launchd.ts';

export type DaemonDeps = Readonly<{
  paths: MsPaths;
  launchctl: Launchctl;
  uid: number;
  controlTimeoutMs: number;
  readyTimeoutMs: number;
  sleep: (ms: number) => Promise<void>;
}>;

const READY_POLL_MS = 200;

function describe(state: ServiceState): string {
  if (!state.loaded) return 'launchd: not loaded';
  return `launchd: loaded, state ${state.state ?? 'unknown'}, pid ${state.pid ?? '-'}`;
}

async function ping(deps: DaemonDeps): Promise<string> {
  const result = await callControl(deps.paths.socket, 'status', {}, { timeoutMs: deps.controlTimeoutMs });
  const status = JSON.parse(renderResult('status', result, true)) as { version: string };
  return status.version;
}

async function waitReady(deps: DaemonDeps): Promise<string> {
  const deadline = Date.now() + deps.readyTimeoutMs;
  for (;;) {
    try { return await ping(deps); } catch (error) {
      if (!(error instanceof CliError) || error.code !== 'DAEMON_UNAVAILABLE') throw error;
      if (Date.now() >= deadline) {
        throw new CliError('DAEMON_START_TIMEOUT',
          `see ${join(deps.paths.logs, 'msd.err.log')}; HELPER_START_FAILED there usually means: run ms repin, `
          + 'which also says when the pinned Python belongs to another user');
      }
    }
    await deps.sleep(READY_POLL_MS);
  }
}

async function start(deps: DaemonDeps, domain: string): Promise<string> {
  if (!(await pathExists(deps.paths.launchAgent))) throw new CliError('NOT_INSTALLED');
  const before = await serviceState(deps.launchctl, domain, LAUNCH_AGENT_LABEL);
  if (before.loaded) return `msd already loaded\n${describe(before)}`;
  await bootstrapService(deps.launchctl, domain, deps.paths.launchAgent);
  const version = await waitReady(deps);
  return `msd ${version} started\n${describe(await serviceState(deps.launchctl, domain, LAUNCH_AGENT_LABEL))}`;
}

async function stop(deps: DaemonDeps, domain: string): Promise<string> {
  const before = await serviceState(deps.launchctl, domain, LAUNCH_AGENT_LABEL);
  if (!before.loaded) return 'msd not loaded';
  await bootoutService(deps.launchctl, domain, LAUNCH_AGENT_LABEL);
  return 'msd stopped';
}

async function status(deps: DaemonDeps, domain: string): Promise<string> {
  const state = await serviceState(deps.launchctl, domain, LAUNCH_AGENT_LABEL);
  let control: string;
  try { control = `control: reachable (msd ${await ping(deps)})`; } catch (error) {
    if (!(error instanceof CliError)) throw error;
    control = `control: ${error.code}`;
  }
  return `${describe(state)}\n${control}`;
}

export async function runDaemon(action: 'start' | 'stop' | 'status', deps: DaemonDeps): Promise<string> {
  const domain = `gui/${deps.uid}`;
  if (action === 'start') return start(deps, domain);
  if (action === 'stop') return stop(deps, domain);
  return status(deps, domain);
}
