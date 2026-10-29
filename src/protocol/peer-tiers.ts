// INPUT: A peer-request tool call (harness, tool name, input, optional MCP annotations) and the peer scope; the shell and path rule files.
// OUTPUT: ActPreset, ACT_PRESETS, ACT_HARNESSES, REASON_HINTS, classifyPeerCall → PeerVerdict (L0–L3, G1, G2), actDecision.
// POS: The shared standard as pure functions, called by msd, the DSH plugin and the Codex bridge. ms only tightens: pass is never an allow.
import { type Harness } from './message.ts';
import { classifyPath, globMayMatchSecret, isTildeUser, resolvePeerPath, type PeerScope } from './peer-paths.ts';
import { classifyArgv, classifyCommand } from './peer-shell.ts';
import { maxTier, pathTier, type Tier, type TierResult } from './peer-tier-base.ts';

export type ActPreset = 'read-only' | 'workspace-write' | 'full-access';
export type ActDecision = 'pass' | 'approve' | 'deny';
export type Gate = 'G1' | 'G2';
export type PeerVerdict = Readonly<{ tier: Tier; gate?: Gate; reason: string }>;
export type McpAnnotations = Readonly<{ readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }>;
export type PeerCall = Readonly<{ harness: Harness; tool: string; input: Readonly<Record<string, unknown>>; annotations?: McpAnnotations }>;

export const ACT_PRESETS: readonly ActPreset[] = Object.freeze(['read-only', 'workspace-write', 'full-access']);
export const isActPreset = (value: unknown): value is ActPreset => ACT_PRESETS.includes(value as ActPreset);
// Act is accepted only for harnesses listed here.
export const ACT_HARNESSES: readonly Harness[] = Object.freeze(['claude-code', 'dsh', 'codex']);

const MATRIX: Readonly<Record<ActPreset, Readonly<Record<Tier, ActDecision>>>> = Object.freeze({
  'read-only': Object.freeze({ L0: 'pass', L1: 'approve', L2: 'approve', L3: 'deny' }),
  'workspace-write': Object.freeze({ L0: 'pass', L1: 'pass', L2: 'approve', L3: 'deny' }),
  'full-access': Object.freeze({ L0: 'pass', L1: 'pass', L2: 'pass', L3: 'deny' }),
});
export const actDecision = (preset: ActPreset, verdict: PeerVerdict): ActDecision => (verdict.gate === undefined ? MATRIX[preset][verdict.tier] : 'deny');
// Text a harness adds when it refuses a call for this reason, so the model can redo the request in an allowed way: the act rules
// (reply-mode-text) forbid doing a refused step another way except as a hint here names.
export const REASON_HINTS: Readonly<Record<string, string>> = Object.freeze({
  'recursive-search': '会输出匹配内容的递归搜索在同伴请求里一律拒绝。可以改为先只列文件名定位（例如 grep -rl 或 Grep 的 files_with_matches），再逐个读具体文件。',
  unparseable: '这条命令含 Switchboard 无法静态判断的写法（例如 `$?`、命令替换）。如果是你在来信要求的命令后面拼接了附加部分，'
    + '可以去掉附加部分、按来信原样再运行一次；来信要求的命令本身就是这样写的，如实告诉对方。',
  'background-work': '需要长时间运行的，请如实告诉对方，由用户自己发起。',
});

const verdict = (tier: Tier, reason: string): PeerVerdict => Object.freeze({ tier, reason });
const gated = (gate: Gate): PeerVerdict => Object.freeze({ tier: 'L3', gate, reason: gate === 'G1' ? 'third-party-send' : 'subagent' });
const L0 = verdict('L0', 'read-only');
const L1 = verdict('L1', 'workspace-write');
const L2 = verdict('L2', 'command');
const NETWORK = verdict('L2', 'network-read');
const UNKNOWN = verdict('L2', 'unknown-tool');
// A skill is L2 like a command; its own reason only changes the text (「使用技能」, not 「执行命令」).
const SKILL = verdict('L2', 'skill');
const INVALID = verdict('L2', 'invalid-input');
const CONFIG = verdict('L3', 'config-change');
const SCHEDULE = verdict('L3', 'config-change');
const UNPARSEABLE = verdict('L3', 'unparseable');
const RECURSIVE_SEARCH = verdict('L3', 'recursive-search');
// Work that keeps running after the letter turn and wakes the session in a later turn that is not a letter turn: G2 like a subagent.
const BACKGROUND: PeerVerdict = Object.freeze({ tier: 'L3', gate: 'G2', reason: 'background-work' });

type Rule = (input: Readonly<Record<string, unknown>>, scope: PeerScope) => PeerVerdict;
const fixed = (value: PeerVerdict): Rule => () => value;
const foreground = (rule: Rule): Rule => (input, scope) => (input.run_in_background === true ? BACKGROUND : rule(input, scope));
// A shell command the shell rules found left running after the turn (a trailing &, nohup, …) is the same gate.
const gateBackground = (tiered: PeerVerdict): PeerVerdict => (tiered.reason === BACKGROUND.reason ? BACKGROUND : tiered);

// A file tool's write inside the workspace is L1; outside it is L2, or L3 for a delete; secrets and protected config are L3.
// A ~name path cannot be resolved here, so it is unparseable.
function fileTier(raw: unknown, scope: PeerScope, access: 'read' | 'write' | 'delete'): PeerVerdict {
  if (typeof raw !== 'string' || raw === '') return INVALID;
  if (isTildeUser(raw)) return UNPARSEABLE;
  if (access === 'read') return pathTier(raw, scope, false);
  const kind = classifyPath(raw, scope);
  if (kind === 'secret') return verdict('L3', 'secret');
  if (kind === 'protected') return CONFIG;
  if (kind === 'outside') return access === 'delete' ? verdict('L3', 'delete-outside') : verdict('L2', 'outside-write');
  return L1;
}
const read = (key: string): Rule => (input, scope) => fileTier(input[key], scope, 'read');
const write = (key: string): Rule => (input, scope) => fileTier(input[key], scope, 'write');
const readOptional = (key: string): Rule => (input, scope) => (input[key] === undefined ? L0 : fileTier(input[key], scope, 'read'));

// A search reads under its path (default: cwd); a glob pattern's fixed directory part counts as part of that path (/etc/*.conf).
const search = (pathKey: string, globKey?: string): Rule => (input, scope) => {
  const base = input[pathKey] ?? '.';
  if (typeof base !== 'string' || base === '') return INVALID;
  const pattern = globKey === undefined ? '' : input[globKey];
  const fixedPart = typeof pattern === 'string' ? pattern.slice(0, pattern.search(/[*?[{]|$/)) : '';
  const root = fixedPart.includes('/') ? fixedPart.slice(0, fixedPart.lastIndexOf('/') + 1) : '';
  return pathTier(root === '' ? base : resolvePeerPath(root, Object.freeze({ ...scope, cwd: resolvePeerPath(base, scope) })), scope, false);
};

// A content search also reads every file its glob filters select (Claude Grep glob, DSH grep glob or include): a filter that can
// select a secret name is a secret read.
// Claude's Grep prints matching lines only in content mode (default files_with_matches); a mode it does not list counts as content.
// DSH's grep always prints matching lines (rg --json), so it is a recursive content search.
const grep = (pathKey: string, globKeys: readonly string[]): Rule => (input, scope) => {
  const mode = input.output_mode;
  if (mode !== undefined && typeof mode !== 'string') return INVALID;
  if (mode !== undefined && mode !== 'files_with_matches' && mode !== 'count') return RECURSIVE_SEARCH;
  const filters = globKeys.map(key => input[key]).filter(value => value !== undefined);
  if (filters.some(value => typeof value !== 'string')) return INVALID;
  if ((filters as string[]).some(globMayMatchSecret)) return verdict('L3', 'secret');
  return maxTier((filters as string[]).map(glob => search(pathKey, 'glob')({ ...input, glob }, scope)), search(pathKey)(input, scope));
};

// Text typed into a DSH terminal runs in its shell: every string field is tiered as a command line, never below L2.
const terminal: Rule = (input, scope) => gateBackground(
  maxTier(Object.values(input).filter((value): value is string => typeof value === 'string').map(text => classifyCommand(text, scope)), L2));

// The host's own sandbox stays the boundary, so asking to widen it (Claude dangerouslyDisableSandbox, DSH or Codex
// sandbox_permissions other than the default) is a permission change. A workdir moves where relative paths resolve and is read itself.
const shell = (floor: PeerVerdict | null): Rule => (input, scope) => {
  if (input.dangerouslyDisableSandbox === true) return CONFIG;
  if (input.sandbox_permissions !== undefined && input.sandbox_permissions !== 'use_default') return CONFIG;
  const workdir = input.workdir ?? input.cwd;
  if (workdir !== undefined && (typeof workdir !== 'string' || workdir === '')) return INVALID;
  const here: PeerScope = workdir === undefined ? scope : Object.freeze({ ...scope, cwd: resolvePeerPath(workdir, scope) });
  const command = input.command;
  const tiered = typeof command === 'string' ? classifyCommand(command, here)
    : Array.isArray(command) && command.length > 0 && command.every(item => typeof item === 'string') ? classifyArgv(command, here)
    : null;
  if (tiered === null) return INVALID;
  return gateBackground(maxTier([tiered, ...(workdir === undefined ? [] : [pathTier(workdir, scope, false)])], floor ?? tiered));
};

// apply_patch carries its own file headers; a patch whose targets cannot be read is L3 like an unparseable command.
const PATCH_FILE = /^\*\*\* (Add|Update|Delete) File: (.+)$/;
const PATCH_MOVE = /^\*\*\* Move to: (.+)$/;
const applyPatch: Rule = (input, scope) => {
  if (typeof input.command !== 'string') return UNPARSEABLE;
  const tiers: PeerVerdict[] = [];
  let updating: string | null = null;
  for (const line of input.command.split('\n').map(item => item.trimEnd())) {
    const file = PATCH_FILE.exec(line); const move = PATCH_MOVE.exec(line);
    if (file !== null) { tiers.push(fileTier(file[2].trim(), scope, file[1] === 'Delete' ? 'delete' : 'write')); updating = file[1] === 'Update' ? file[2].trim() : null; }
    if (move !== null) {
      if (updating === null) return UNPARSEABLE;
      tiers.push(fileTier(updating, scope, 'delete'), fileTier(move[1].trim(), scope, 'write'));
    }
  }
  return tiers.length === 0 ? UNPARSEABLE : maxTier(tiers, tiers[0]);
};

// Claude Code reaches ms through the ms:message skill: loading it without args only reads its text, reply and list are the
// answer itself, send is a third-party send, and the register, unregister, auto and reply commands change ms's own config.
// Arguments it cannot read stay L2 as unreadable input; any other skill is L2 as a skill.
const MS_CONFIG_SKILLS = new Set(['ms:register', 'ms:unregister', 'ms:auto', 'ms:reply']);
const skill: Rule = input => {
  if (typeof input.skill !== 'string') return INVALID;
  if (MS_CONFIG_SKILLS.has(input.skill)) return CONFIG;
  if (input.skill !== 'ms:message') return SKILL;
  // No args only loads the skill text (the model reading the rules first): a read, not an operation.
  if (input.args === undefined || input.args === '') return L0;
  try {
    const args: unknown = JSON.parse(typeof input.args === 'string' ? input.args : '');
    const operation = typeof args === 'object' && args !== null ? (args as Record<string, unknown>).operation : undefined;
    if (operation === 'reply' || operation === 'list') return L0;
    if (operation === 'send') return gated('G1');
    if (operation === 'register' || operation === 'unregister') return CONFIG;
  } catch { /* falls through: the skill rejects it anyway */ }
  return INVALID;
};

const ROUTER: Readonly<Record<string, Rule>> = Object.freeze({ router_reply: fixed(L0), router_list_sessions: fixed(L0),
  router_send: fixed(gated('G1')), router_register: fixed(CONFIG), router_unregister: fixed(CONFIG) });

const CLAUDE: Readonly<Record<string, Rule>> = Object.freeze({
  Read: read('file_path'), Grep: grep('path', ['glob']), Glob: search('path', 'pattern'), LSP: readOptional('filePath'),
  Edit: write('file_path'), MultiEdit: write('file_path'), Write: write('file_path'), NotebookEdit: write('notebook_path'),
  Bash: foreground(shell(null)), PowerShell: foreground(shell(L2)), Skill: skill,
  TodoWrite: fixed(L0), TaskCreate: fixed(L0), TaskUpdate: fixed(L0), TaskList: fixed(L0), TaskGet: fixed(L0), TaskOutput: fixed(L0),
  AskUserQuestion: fixed(L0), EnterPlanMode: fixed(L0), ExitPlanMode: fixed(L0), ToolSearch: fixed(L0),
  WebFetch: fixed(NETWORK), WebSearch: fixed(NETWORK), Monitor: fixed(BACKGROUND),
  CronCreate: fixed(SCHEDULE), CronDelete: fixed(SCHEDULE), ScheduleWakeup: fixed(SCHEDULE), RemoteTrigger: fixed(SCHEDULE),
  ShareOnboardingGuide: fixed(verdict('L3', 'egress')),
  SendMessage: fixed(gated('G1')), ListAgents: fixed(gated('G1')), Agent: fixed(gated('G2')), Task: fixed(gated('G2')), Workflow: fixed(gated('G2')),
});

const DSH: Readonly<Record<string, Rule>> = Object.freeze({
  ...ROUTER, read: read('file_path'), read_image: read('file_path'), glob: search('path', 'pattern'), grep: fixed(RECURSIVE_SEARCH),
  write: write('file_path'), edit: write('file_path'),
  str_replace_editor: (input, scope) => (input.command === 'view' ? read('path') : write('path'))(input, scope),
  bash: foreground(shell(null)), pwsh: foreground(shell(L2)),
  todo_write: fixed(L0), ask_user_question: fixed(L0), present: fixed(L0), get_goal: fixed(L0), job_list: fixed(L0), job_output: fixed(L0),
  terminal_read: fixed(L0), terminal_list: fixed(L0), create_goal: fixed(BACKGROUND), update_goal: fixed(BACKGROUND),
  // A run_code program can use Node APIs no tool call sees, and DSH's sandbox only limits writes: an inline program like
  // node -e. A session showing tools as PTC never enters act (act-gate canAct), so this only meets a mid-turn switch.
  run_code: fixed(UNPARSEABLE),
  terminal_open: terminal, terminal_send: foreground(terminal), terminal_signal: fixed(L2), terminal_close: fixed(L2), job_kill: fixed(L2),
  web_search: fixed(NETWORK), web_fetch: fixed(NETWORK), skill: fixed(SKILL), load_workspace_dependencies: fixed(L2),
  // plugin_manager installs, enables and removes profile plugins: DSH profile and plugin config.
  plugin_manager: fixed(CONFIG),
  // Handing work to another agent: a subagent's or teammate's calls never reach the parent's agent-scoped gate.
  // subagent and subagent_fork are the default presets' two delegate tools; spawn_teammate, the team task board and send_message
  // come with the experimental agent team; list_agents is the listing step of a send, like Claude's ListAgents.
  send_message: fixed(gated('G1')), interrupt_agent: fixed(gated('G1')), list_agents: fixed(gated('G1')),
  team_task_create: fixed(gated('G1')), team_task_update: fixed(gated('G1')),
  subagent: fixed(gated('G2')), subagent_fork: fixed(gated('G2')), spawn_teammate: fixed(gated('G2')), ralph: fixed(gated('G2')),
  workflow: fixed(gated('G2')),
});
// DSH tool families named by prefix: inspecting is read-only, other sessions' records are L2, scheduling is persistent config.
const DSH_PREFIXES: ReadonlyArray<readonly [string, PeerVerdict]> = [['cordis_inspect_', L0], ['session_', L2], ['schedule_', SCHEDULE]];

// Hook names are the tool's namespace glued to its name (clockcurr_time, collaborationspawn_agent), so only exact names are
// listed here; goals come without a namespace.
const CODEX: Readonly<Record<string, Rule>> = Object.freeze({
  ...ROUTER, Bash: shell(null), apply_patch: applyPatch, view_image: readOptional('path'), update_plan: fixed(L0),
  request_permissions: fixed(CONFIG), get_goal: fixed(L0), create_goal: fixed(BACKGROUND), update_goal: fixed(BACKGROUND),
  clockcurr_time: fixed(L0), clocksleep: fixed(L0),
});
// Multi-agent tools sit in a configurable namespace, so they are matched by name ending: a stray match only denies more.
// Spawning or reviving an agent is G2 (its calls never come back to the letter turn); talking to, waiting on, listing, closing
// or interrupting other agents is G1.
const CODEX_AGENT_TOOLS: ReadonlyArray<readonly [string, PeerVerdict]> = [['spawn_agent', gated('G2')], ['resume_agent', gated('G2')],
  ...['send_input', 'send_message', 'followup_task', 'wait_agent', 'list_agents', 'close_agent', 'interrupt_agent']
    .map(name => [name, gated('G1')] as const)];

// Codex names ms's own MCP tools mcp__ms__router_*; they follow the router rules, every other MCP tool is L2.
function baseVerdict(call: PeerCall, scope: PeerScope): PeerVerdict {
  const tool = call.harness === 'codex' ? call.tool.replace(/^mcp__ms__(?=router_)/, '') : call.tool;
  const table = call.harness === 'claude-code' ? CLAUDE : call.harness === 'dsh' ? DSH : CODEX;
  if (Object.hasOwn(table, tool)) return table[tool](call.input, scope);
  if (tool.startsWith('mcp__')) return verdict('L2', 'mcp');
  const family = call.harness === 'dsh' ? DSH_PREFIXES.find(([prefix]) => tool.startsWith(prefix))
    : call.harness === 'codex' ? CODEX_AGENT_TOOLS.find(([name]) => tool.endsWith(name)) : undefined;
  return family === undefined ? UNKNOWN : family[1];
}

// MCP annotations only raise: an explicit destructiveHint (not contradicted by readOnlyHint) is L3; nothing lowers a tier.
export function classifyPeerCall(call: PeerCall, scope: PeerScope): PeerVerdict {
  const base = baseVerdict(call, scope);
  const destructive = call.annotations?.destructiveHint === true && call.annotations.readOnlyHint !== true;
  return destructive && base.gate === undefined ? verdict('L3', 'destructive-tool') : base;
}
