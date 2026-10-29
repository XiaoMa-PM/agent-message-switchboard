// INPUT: process argv/env/cwd and signals, the running Node binary, /usr/bin/open and the daily Claude plugin generator.
// OUTPUT: Process exit code from runCli wired to the real launchctl, pin probe, HOME paths and, for ms ui, the default browser
//         and Ctrl+C.
// POS: ms CLI entry (a staging copy of the package during install, then the installed bundle, run by the npm launcher or
//      <root>/bin/ms); contains no logic of its own.
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { prepareDailyClaudeMarketplace } from '../daemon/claude-plugin.ts';
import { prepareDailyCodexMarketplace } from '../adapters/codex/plugin.ts';
import { planClaudeMarketplaceStep, systemClaudeCli } from './claude-marketplace-step.ts';
import { planCodexPluginStep, systemCodexCli } from './codex-plugin-step.ts';
import { callControl } from './control-client.ts';
import { systemDshPnpm } from './dsh-bundle.ts';
import { createHandlers } from './handlers.ts';
import { kickstartService, systemLaunchctl } from './launchd.ts';
import { runCli } from './main.ts';
import { LAUNCH_AGENT_LABEL, resolvePaths } from './paths.ts';
import { discoverPins, systemPinProbe } from './pins.ts';

const CONTROL_TIMEOUT_MS = 5000;
const READY_TIMEOUT_MS = 10000;

const home = process.env.HOME ?? '';
const paths = resolvePaths(home);
const probe = systemPinProbe(process.env.PATH ?? '');
const launchctl = systemLaunchctl();
const claudeCli = systemClaudeCli();
const codexCli = systemCodexCli();
const uid = process.getuid?.() ?? -1;

const handlers = createHandlers({
  repin: {
    paths,
    now: () => new Date().toISOString(),
    discoverPins: () => discoverPins(probe),
    generate: prepareDailyClaudeMarketplace,
    reload: () => callControl(paths.socket, 'config.reload', {}, { timeoutMs: CONTROL_TIMEOUT_MS }),
    restart: () => kickstartService(launchctl, `gui/${uid}`, LAUNCH_AGENT_LABEL),
  },
  env: {
    paths,
    sourceRoot: fileURLToPath(new URL('../../', import.meta.url)),
    nodePath: realpathSync(process.execPath),
    now: () => new Date().toISOString(),
    discoverPins: () => discoverPins(probe),
    planClaude: options => planClaudeMarketplaceStep({ paths, generate: prepareDailyClaudeMarketplace, claude: claudeCli }, options),
    dshPnpm: systemDshPnpm(),
    claudeCli,
    planCodex: target => planCodexPluginStep({ paths, generate: prepareDailyCodexMarketplace, codex: codexCli }, target),
    codexCli,
  },
  launchctl,
  uid,
  controlTimeoutMs: CONTROL_TIMEOUT_MS,
  readyTimeoutMs: READY_TIMEOUT_MS,
  sleep: ms => sleep(ms),
  ui: {
    open: url => new Promise<void>((resolve, reject) => { execFile('/usr/bin/open', [url], error => (error ? reject(error) : resolve())); }),
    untilStopped: () => new Promise<void>(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); }),
  },
});

process.exitCode = await runCli(process.argv.slice(2), {
  io: { out: text => process.stdout.write(`${text}\n`), err: text => process.stderr.write(`${text}\n`) },
  cwd: process.cwd(),
  paths,
  controlTimeoutMs: CONTROL_TIMEOUT_MS,
  handlers,
});
