// INPUT: A Codex-spawned stdio process: argv --root, env CODEX_HOME, kernel parent pid and ps facts.
// OUTPUT: The Codex MCP server bound to its owner app-server and attached to msd in the background; refuses under an exec-server parent.
// POS: Process entry started by the ms@ms-local Codex plugin's .mcp.json; spawned directly by Codex.
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { codexQueueLaunch, openQueueSession } from './app-server-queue.ts';
import { createCodexBridge, type ToolResult } from './bridge.ts';
import { readGitWorktree } from '../git-worktree.ts';
import { codexActHooksTrusted } from './hook-trust.ts';
import { blockReason, codexFailureText, parseCodexCommand } from './commands.ts';
import { msdSocketPath } from './msd-channel.ts';
import { serveMcp } from './mcp-server.ts';
import { isRemoteExecutor, lsofHolders, psCommandLine, psProcessFacts, surfaceOf } from './thread-owner.ts';

export const QUEUE_TIMEOUT_MS = 20_000;
export const REMOTE_ENVIRONMENT_NOTE = 'ChatGPT 的 Local Work（云端驱动、本机执行）线程不支持 Switchboard，请改用 Codex 标签页的本地线程或 Codex CLI。';
const REMOTE_REFUSAL: ToolResult = Object.freeze({ isError: true,
  value: Object.freeze({ error: 'UNSUPPORTED_CODEX_REMOTE_ENVIRONMENT', note: REMOTE_ENVIRONMENT_NOTE }) });
// Hook failures are silent everywhere, so a new Local Work thread shows no SessionStart hook error; no letter reaches such a thread,
// so the act hooks pass every call and the turn end settles nothing, instead of a Hook failed on each.
const SILENT: ToolResult = Object.freeze({ isError: false, value: undefined });
const SILENT_HOOKS = new Set(['router_session_start', 'router_pre_tool_use', 'router_permission_request', 'router_turn_end']);
function remoteCall(name: string, args: unknown, codexHome: string): ToolResult {
  if (SILENT_HOOKS.has(name)) return SILENT;
  if (name !== 'router_prompt_command') return REMOTE_REFUSAL;
  const command = parseCodexCommand((args as Record<string, unknown> | null)?.prompt, codexHome);
  if (command === null) return SILENT;
  const reason = codexFailureText(command.kind, 'UNSUPPORTED_CODEX_REMOTE_ENVIRONMENT', REMOTE_ENVIRONMENT_NOTE.replace(/。$/, ''));
  return Object.freeze({ isError: false, value: blockReason(reason) });
}

export type MainOptions = Readonly<{ root: string; codexHome: string }>;

function absolute(value: string | undefined, code: string): string {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(code);
  return value;
}

export function parseMainOptions(argv: readonly string[], env: NodeJS.ProcessEnv, home: string): MainOptions {
  let root = join(home, 'Library', 'Application Support', 'agent-message-switchboard');
  for (let index = 0; index < argv.length; index += 2) {
    if (argv[index] !== '--root') throw new Error('INVALID_ARGUMENTS');
    root = absolute(argv[index + 1], 'INVALID_ARGUMENTS');
  }
  const codexHome = env.CODEX_HOME === undefined || env.CODEX_HOME === '' ? join(home, '.codex')
    : absolute(env.CODEX_HOME, 'INVALID_CODEX_HOME');
  return Object.freeze({ root, codexHome });
}

export async function main(): Promise<void> {
  const options = parseMainOptions(process.argv.slice(2), process.env, homedir());
  const ownerPid = process.ppid;
  const owner = await psProcessFacts(ownerPid).catch(() => null);
  if (owner && isRemoteExecutor(owner.executable, await psCommandLine(ownerPid).catch(() => ''))) {
    // The thread lives in the cloud: no local writer lock or queue owner exists, so refuse without touching msd.
    await serveMcp({ input: process.stdin, output: process.stdout, call: async (name, args) => remoteCall(name, args, options.codexHome) });
    return;
  }
  const parent = owner ? await psProcessFacts(owner.parentPid).catch(() => null) : null;
  const bridge = createCodexBridge({ socketPath: msdSocketPath(options.root), codexHome: options.codexHome, ownerPid,
    surface: parent ? surfaceOf(parent.executable) : 'cli', cwd: process.cwd(), instanceId: `codex:${randomUUID()}`,
    listHolders: lsofHolders, projectOf: readGitWorktree, home: homedir(), hooksTrusted: () => codexActHooksTrusted(options.codexHome),
    openQueue: () => owner && isAbsolute(owner.executable)
      ? openQueueSession(codexQueueLaunch(owner.executable), QUEUE_TIMEOUT_MS)
      : Promise.reject(new Error('OWNER_PROBE_FAILED')) });
  bridge.start();
  try { await serveMcp({ input: process.stdin, output: process.stdout, call: bridge.call }); }
  finally { bridge.close(); }
}

if (import.meta.main) {
  main().catch(error => { process.stderr.write(`ms codex mcp: ${(error as Error).message}\n`); process.exitCode = 1; });
}
