// INPUT: argv, output sinks, resolved ms paths and install/uninstall/daemon handlers.
// OUTPUT: runCli → process exit code; control commands go through the msd socket, `ui` runs the status page handler until stopped,
//         `upgrade` prints its steps as they finish (its dry run only the plan), errors print fixed codes.
// POS: Thin ms dispatcher shared by the bin launcher and tests; owns no side effects itself.
import { parseArgs, type ControlCommand, type Harness } from './args.ts';
import { callControl } from './control-client.ts';
import { renderResult } from './format.ts';
import { CliError, exitCodeFor } from './errors.ts';
import type { MsPaths } from './paths.ts';

export type CliHandlers = Readonly<{
  install: (dryRun: boolean, harness: Harness | null) => Promise<string>;
  repin: (dryRun: boolean) => Promise<string>;
  uninstall: (dryRun: boolean, keepData: boolean, harness: Harness | null) => Promise<string>;
  daemon: (action: 'start' | 'stop' | 'status') => Promise<string>;
  ui: (out: (text: string) => void) => Promise<string>;
  upgrade: (dryRun: boolean, out: (text: string) => void) => Promise<string>;
}>;

export type CliDeps = Readonly<{
  io: Readonly<{ out: (text: string) => void; err: (text: string) => void }>;
  cwd: string;
  paths: MsPaths;
  controlTimeoutMs: number;
  handlers: CliHandlers;
}>;

export const HELP = [
  'usage: ms <command>',
  '',
  '  install [--dry-run]                 install the core (pinned bundle, msd LaunchAgent, fallback launcher) and every harness plugin;',
  '                                      a harness whose preconditions fail is skipped with a manual-install pointer',
  '  install --harness claude-code|dsh|codex [--dry-run]',
  '                                      install or reinstall one harness plugin (the core must be installed)',
  '  uninstall [--dry-run] [--keep-data] revert exactly what install recorded (--keep-data keeps <root>/state and config.json)',
  '  uninstall --harness claude-code|dsh|codex [--dry-run]',
  '                                      revert one harness plugin only; the core and the others stay',
  '  upgrade [--dry-run]                 after npm i -g agent-message-switchboard@latest: replace the installed version, keeping',
  '                                      state/ and settings (stops msd, has the old version uninstall itself, installs, starts msd)',
  '  repin [--dry-run]                   re-pin the Python interpreter (and wrappers) after updates and reload msd',
  '  daemon start|stop|status            manage the msd LaunchAgent',
  '  ui                                  open the read-only status page in the browser (Ctrl+C stops it)',
  '  status [--json]                     daemon summary',
  '  sessions [--harness claude-code|dsh|codex] [--project <dir>] [--json]',
  '  projects [--json]',
  '  alias <claude-code|dsh|codex> <sessionId> <name>|--clear [--json]',
  '  links [--json]',
  '  links resume <linkId> [--json]',
  '  messages [--link <linkId>] [--limit 1-200] [--json]',
  '  config get [--json]',
  '  config set auto-register [--harness claude-code|dsh|codex | --project <dir>] on|off [--json]',
  '  config set reply-mode [--harness claude-code|dsh|codex] direct|confirm|act [--json]',
  '  config set act-preset [--harness claude-code|dsh|codex] read-only|workspace-write|full-access [--json]',
  '  config set link-budget --window-seconds <n> --max-pushes <n> [--json]',
].join('\n');

const HINTS: Readonly<Record<string, string>> = Object.freeze({
  USAGE_INVALID: ' (run `ms help`)',
  DAEMON_UNAVAILABLE: ' (run `ms daemon start`)',
});
const PIN_MISMATCH_CODES: ReadonlySet<string> = new Set(['RUNTIME_PIN_MISMATCH', 'UNSUPPORTED_RUNTIME']);

function hint(error: CliError): string {
  if (error.code === 'DAEMON_ERROR' && PIN_MISMATCH_CODES.has(error.detail ?? '')) return ' (run `ms repin`)';
  return HINTS[error.code] ?? '';
}

async function runControl(command: ControlCommand, deps: CliDeps): Promise<string> {
  const result = await callControl(deps.paths.socket, command.method, command.params, { timeoutMs: deps.controlTimeoutMs });
  return renderResult(command.view, result, command.json);
}

async function dispatch(argv: readonly string[], deps: CliDeps): Promise<string> {
  const command = parseArgs(argv, deps.cwd);
  if (command.kind === 'help') return HELP;
  if (command.kind === 'install') return deps.handlers.install(command.dryRun, command.harness);
  if (command.kind === 'repin') return deps.handlers.repin(command.dryRun);
  if (command.kind === 'uninstall') return deps.handlers.uninstall(command.dryRun, command.keepData, command.harness);
  if (command.kind === 'daemon') return deps.handlers.daemon(command.action);
  if (command.kind === 'ui') return deps.handlers.ui(deps.io.out);
  if (command.kind === 'upgrade') return deps.handlers.upgrade(command.dryRun, deps.io.out);
  return runControl(command, deps);
}

function failure(error: unknown): { code: string; line: string } {
  if (error instanceof CliError) {
    const detail = error.detail === undefined ? '' : `: ${error.detail}`;
    return { code: error.code, line: `ms: ${error.code}${detail}${hint(error)}` };
  }
  if (error instanceof Error && error.message === 'USAGE_INVALID') {
    return { code: 'USAGE_INVALID', line: `ms: USAGE_INVALID${HINTS.USAGE_INVALID}` };
  }
  return { code: 'INTERNAL_ERROR', line: 'ms: INTERNAL_ERROR' };
}

export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  try {
    deps.io.out(await dispatch(argv, deps));
    return 0;
  } catch (error) {
    const { code, line } = failure(error);
    deps.io.err(line);
    return exitCodeFor(code);
  }
}
