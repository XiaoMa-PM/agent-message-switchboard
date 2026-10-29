// INPUT: Fixed ms failure codes raised by CLI modules.
// OUTPUT: CliError and exitCodeFor → stable process exit codes.
// POS: Single error vocabulary for the CLI; messages never carry file contents or message bodies.
const EXIT_CODES: Readonly<Record<string, number>> = Object.freeze({
  DAEMON_ERROR: 1,
  USAGE_INVALID: 2,
  DAEMON_UNAVAILABLE: 3,
  DAEMON_TIMEOUT: 3,
  DAEMON_START_TIMEOUT: 3,
  DAEMON_PROTOCOL_INVALID: 4,
  INSTALL_PRECONDITION_FAILED: 5,
  INSTALL_FAILED: 5,
  INSTALL_ALREADY_PRESENT: 5,
  UNSUPPORTED_PYTHON_SIGNATURE: 5,
  UNSUPPORTED_PYTHON_OWNER: 5,
  NOT_INSTALLED: 5,
  MANIFEST_INVALID: 5,
  UNINSTALL_CONFLICT: 6,
  REPIN_CONFLICT: 6,
  REPIN_FAILED: 5,
  ROOT_REMOVE_FAILED: 5,
  DSH_PNPM_FAILED: 5,
  CLAUDE_CLI_FAILED: 5,
  CODEX_CLI_FAILED: 5,
  LAUNCHD_FAILED: 7,
  UI_START_FAILED: 5,
  MS_SOCKET_PATH_TOO_LONG: 5,
  MS_UPGRADE_PRECONDITION_FAILED: 5,
  MS_UPGRADE_UNINSTALL_FAILED: 6,
  MS_UPGRADE_INSTALL_FAILED: 5,
  MS_UPGRADE_START_FAILED: 3,
});

export class CliError extends Error {
  readonly code: string;
  readonly detail: string | undefined;

  constructor(code: string, detail?: string) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

export function exitCodeFor(code: string): number {
  return Object.hasOwn(EXIT_CODES, code) ? EXIT_CODES[code] : 70;
}
