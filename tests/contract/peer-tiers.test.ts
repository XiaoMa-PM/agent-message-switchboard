// INPUT: Synthetic tool calls (name + input) for Claude Code, DSH and Codex and a synthetic workspace scope.
// OUTPUT: Contract: each harness's tools map to L0-L3 or a gate (G1, G2); MCP annotations only raise a tier; preset x tier gives a verdict.
// POS: Pure contract for src/protocol/peer-tiers.ts; the tier tables in executable form.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ACT_HARNESSES, ACT_PRESETS, actDecision, classifyPeerCall, isActPreset, REASON_HINTS, type PeerCall } from '../../src/protocol/peer-tiers.ts';

const scope = Object.freeze({ workspace: '/repo', cwd: '/repo', home: '/Users/u' });
const call = (harness: PeerCall['harness'], tool: string, input: Record<string, unknown> = {}, annotations?: PeerCall['annotations']) =>
  classifyPeerCall(Object.freeze({ harness, tool, input, ...(annotations ? { annotations } : {}) }), scope);
const verdict = (result: ReturnType<typeof call>) => result.gate ?? result.tier;

test('presets: read-only, workspace-write (default first) and full-access, each tier fixed and L3 never opened', () => {
  assert.deepEqual(ACT_PRESETS, ['read-only', 'workspace-write', 'full-access']);
  for (const value of ACT_PRESETS) assert.equal(isActPreset(value), true);
  for (const value of ['strict', 'standard', 'open', 'danger-full-access', '', null]) assert.equal(isActPreset(value), false);
  const table = { 'read-only': ['pass', 'approve', 'approve', 'deny'], 'workspace-write': ['pass', 'pass', 'approve', 'deny'],
    'full-access': ['pass', 'pass', 'pass', 'deny'] } as const;
  for (const preset of ACT_PRESETS) {
    assert.deepEqual((['L0', 'L1', 'L2', 'L3'] as const).map(tier => actDecision(preset, { tier, reason: 'x' })), table[preset], preset);
    for (const gate of ['G1', 'G2'] as const) assert.equal(actDecision(preset, { tier: 'L0', gate, reason: 'x' }), 'deny');
  }
});

test('act is enforced for Claude Code, DSH and Codex', () => {
  assert.deepEqual([...ACT_HARNESSES], ['claude-code', 'dsh', 'codex']);
});

test('Claude Code tools map to the shared tiers and gates', () => {
  const cases: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
    ['Read', { file_path: '/repo/a.ts' }, 'L0'], ['Read', { file_path: '/etc/hosts' }, 'L2'], ['Read', { file_path: '~/.ssh/id_rsa' }, 'L3'],
    ['Grep', { pattern: 'x' }, 'L0'], ['Glob', { pattern: '*.ts', path: '/tmp' }, 'L2'], ['LSP', {}, 'L0'],
    ['Edit', { file_path: 'src/a.ts' }, 'L1'], ['Write', { file_path: '/tmp/x' }, 'L2'], ['Edit', { file_path: 'CLAUDE.md' }, 'L3'],
    ['NotebookEdit', { notebook_path: 'n.ipynb' }, 'L1'], ['Bash', { command: 'ls' }, 'L0'], ['Bash', { command: 'npm test' }, 'L2'],
    ['Bash', { command: 'git push' }, 'L3'], ['Bash', { command: 'ls', dangerouslyDisableSandbox: true }, 'L3'],
    ['WebFetch', { url: 'https://x' }, 'L2'], ['WebSearch', { query: 'x' }, 'L2'], ['TodoWrite', {}, 'L0'], ['AskUserQuestion', {}, 'L0'],
    ['EnterPlanMode', {}, 'L0'], ['Monitor', {}, 'G2'], ['CronCreate', {}, 'L3'], ['ShareOnboardingGuide', {}, 'L3'],
    ['Bash', { command: 'npm test', run_in_background: true }, 'G2'], ['Bash', { command: 'ls', run_in_background: false }, 'L0'],
    ['PowerShell', { command: 'Get-Date', run_in_background: true }, 'G2'],
    ['Agent', {}, 'G2'], ['Task', {}, 'G2'], ['Workflow', {}, 'G2'], ['SendMessage', {}, 'G1'], ['ListAgents', {}, 'G1'],
    ['Skill', { skill: 'ms:message', args: '{"schemaVersion":1,"operation":"reply","inReplyTo":"m","body":"x"}' }, 'L0'],
    ['Skill', { skill: 'ms:message', args: '{"schemaVersion":1,"operation":"list"}' }, 'L0'],
    ['Skill', { skill: 'ms:message', args: '{"schemaVersion":1,"operation":"send","harness":"dsh","target":"x","body":"y"}' }, 'G1'],
    ['Skill', { skill: 'ms:message', args: '{"schemaVersion":1,"operation":"register"}' }, 'L3'],
    ['Skill', { skill: 'ms:message', args: 'not json' }, 'L2'], ['Skill', { skill: 'other:thing' }, 'L2'],
    ['Skill', { skill: 'ms:message' }, 'L0'], ['Skill', { skill: 'ms:message', args: '' }, 'L0'],
    ['Skill', { skill: 'ms:message', args: '{"schemaVersion":1,"operation":"dance"}' }, 'L2'], ['Skill', { skill: 'ms:message', args: 3 }, 'L2'],
    ['mcp__srv__tool', {}, 'L2'], ['SomethingNew', {}, 'L2'],
  ];
  for (const [tool, input, expected] of cases) assert.equal(verdict(call('claude-code', tool, input)), expected, `${tool} ${JSON.stringify(input)}`);
});

// The reason only picks the text; the tier stays L2. ms:message with arguments it cannot
// read is a call with unreadable input, any other skill (Claude's Skill or DSH's skill tool) is 「使用技能」, not 「执行命令」.
test('a skill call and an ms:message call with unreadable arguments keep L2 under their own reasons', () => {
  for (const args of ['not json', '{"schemaVersion":1,"operation":"dance"}', 3, '[]', 'null']) {
    assert.deepEqual(call('claude-code', 'Skill', { skill: 'ms:message', args }), { tier: 'L2', reason: 'invalid-input' }, String(args));
  }
  assert.deepEqual(call('claude-code', 'Skill', { skill: 'other:thing' }), { tier: 'L2', reason: 'skill' });
  assert.deepEqual(call('dsh', 'skill', { name: 'x' }), { tier: 'L2', reason: 'skill' });
});

test('DSH tools map to the shared tiers and gates; a bash workdir moves where relative paths resolve', () => {
  const cases: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
    ['read', { file_path: 'a.ts' }, 'L0'], ['read', { file_path: '.env' }, 'L3'], ['read_image', { file_path: 'a.png' }, 'L0'],
    ['glob', { pattern: '*.ts' }, 'L0'], ['grep', { pattern: 'x', path: '/etc' }, 'L3'], ['write', { file_path: 'a.ts' }, 'L1'],
    ['edit', { file_path: '.git/config' }, 'L3'], ['str_replace_editor', { command: 'view', path: 'a.ts' }, 'L0'],
    ['str_replace_editor', { command: 'str_replace', path: 'a.ts' }, 'L1'], ['bash', { command: 'ls' }, 'L0'],
    ['bash', { command: 'cat a.ts', workdir: '/tmp' }, 'L2'], ['bash', { command: 'ls', sandbox_permissions: 'workspace-write' }, 'L3'],
    ['pwsh', { command: 'Get-ChildItem' }, 'L2'], ['web_fetch', { url: 'https://x' }, 'L2'], ['web_search', {}, 'L2'],
    ['todo_write', {}, 'L0'], ['ask_user_question', {}, 'L0'], ['present', {}, 'L0'], ['get_goal', {}, 'L0'], ['create_goal', {}, 'G2'], ['update_goal', { action: 'complete' }, 'G2'],
    ['job_list', {}, 'L0'], ['terminal_read', {}, 'L0'], ['terminal_send', {}, 'L2'], ['job_kill', {}, 'L2'], ['skill', {}, 'L2'],
    ['session_search', {}, 'L2'], ['cordis_inspect_list', {}, 'L0'], ['schedule_create', {}, 'L3'], ['load_workspace_dependencies', {}, 'L2'],
    ['send_message', {}, 'G1'], ['interrupt_agent', {}, 'G1'], ['subagent', {}, 'G2'], ['ralph', {}, 'G2'], ['workflow', {}, 'G2'],
    ['router_reply', {}, 'L0'], ['router_list_sessions', {}, 'L0'], ['router_send', {}, 'G1'], ['router_register', {}, 'L3'],
    ['run_code', { code: 'x' }, 'L3'], ['run_code', { code: 'x', sandbox_permissions: 'danger-full-access' }, 'L3'],
    ['mcp__srv__tool', {}, 'L2'], ['bash', { command: 'sleep 99', run_in_background: true }, 'G2'],
    ['pwsh', { command: 'Start-Sleep 99', run_in_background: true }, 'G2'], ['terminal_send', { text: 'ls', run_in_background: true }, 'G2'],
    // Everything else that hands work to another agent, and installing plugins (profile config).
    ['subagent_fork', {}, 'G2'], ['spawn_teammate', {}, 'G2'], ['list_agents', {}, 'G1'], ['team_task_create', {}, 'G1'],
    ['team_task_update', {}, 'G1'], ['plugin_manager', {}, 'L3'], ['plugin_market', {}, 'L2'], ['wait_agent', {}, 'L2'],
  ];
  for (const [tool, input, expected] of cases) assert.equal(verdict(call('dsh', tool, input)), expected, `${tool} ${JSON.stringify(input)}`);
});

// Codex runs shell commands as argv, usually wrapped as [bash|zsh|sh, -lc|-c, script]: the wrapper is the host's own, so the script
// inside is tiered like any command string; other argv arrays are one already-split command.
// Work that keeps running after the letter turn and wakes the session later is G2 background-work;
// a DSH run_code program uses Node APIs that no tool call sees, like node -e, so it is L3 unparseable.
test('background work is G2 background-work with a hint, and a DSH run_code program is L3 unparseable', () => {
  for (const [harness, tool, input] of [['claude-code', 'Bash', { command: 'ls', run_in_background: true }], ['claude-code', 'Monitor', {}],
    ['claude-code', 'PowerShell', { command: 'x', run_in_background: true }], ['dsh', 'bash', { command: 'ls', run_in_background: true }],
    ['dsh', 'terminal_send', { text: 'ls', run_in_background: true }], ['dsh', 'create_goal', {}], ['dsh', 'update_goal', {}],
    // A shell command left running after the turn, in all three harnesses; Codex goals.
    ['claude-code', 'Bash', { command: 'npm run dev &' }], ['claude-code', 'PowerShell', { command: 'nohup x' }],
    ['dsh', 'bash', { command: 'sleep 999 &' }], ['dsh', 'terminal_send', { text: 'python job.py &' }],
    ['dsh', 'terminal_open', { command: 'setsid x.sh' }], ['codex', 'Bash', { command: 'nohup x.sh &' }],
    ['codex', 'Bash', { command: ['bash', '-lc', 'sleep 9 &'] }], ['codex', 'create_goal', {}], ['codex', 'update_goal', {}],
    // Lasting work started by screen, tmux, at, batch or launchctl.
    ['claude-code', 'Bash', { command: 'launchctl load x.plist' }], ['dsh', 'bash', { command: 'screen -dm make' }],
    ['codex', 'Bash', { command: 'tmux new -d make' }], ['codex', 'Bash', { command: 'echo ls | at now' }]] as const) {
    assert.deepEqual(call(harness, tool, input), { tier: 'L3', gate: 'G2', reason: 'background-work' }, `${harness} ${tool}`);
  }
  assert.equal(REASON_HINTS['background-work'], '需要长时间运行的，请如实告诉对方，由用户自己发起。');
  assert.deepEqual(call('dsh', 'run_code', { code: 'await tools.read({ file_path: "a" })' }), { tier: 'L3', reason: 'unparseable' });
});

test('Codex tools map to the shared tiers and gates, including argv commands and apply_patch file headers', () => {
  const patch = (header: string) => ({ command: `*** Begin Patch\n${header}\n+x\n*** End Patch` });
  const cases: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
    ['Bash', { command: 'ls' }, 'L0'], ['Bash', { command: ['git', 'push'] }, 'L3'], ['Bash', { command: ['bash', '-lc', 'ls'] }, 'L0'],
    ['Bash', { command: ['zsh', '-lc', 'git push origin main'] }, 'L3'], ['Bash', { command: ['cat', '/etc/hosts'] }, 'L2'],
    ['Bash', { command: ['bash', '-lc', 'echo $(id)'] }, 'L3'],
    ['apply_patch', patch('*** Update File: src/a.ts'), 'L1'], ['apply_patch', patch('*** Add File: ../x.ts'), 'L2'],
    ['apply_patch', patch('*** Delete File: /etc/x'), 'L3'], ['apply_patch', patch('*** Update File: .codex/config.toml'), 'L3'],
    ['apply_patch', { command: 'no headers' }, 'L3'], ['view_image', {}, 'L0'], ['update_plan', {}, 'L0'],
    ['request_permissions', {}, 'L3'], ['spawn_agent', {}, 'G2'], ['send_message', {}, 'G1'], ['followup_task', {}, 'G1'],
    ['router_reply', {}, 'L0'], ['router_send', {}, 'G1'], ['mcp__srv__tool', {}, 'L2'],
    ['mcp__ms__router_reply', {}, 'L0'], ['mcp__ms__router_send', {}, 'G1'], ['mcp__ms__router_register', {}, 'L3'],
    ['get_goal', {}, 'L0'], ['clockcurr_time', {}, 'L0'], ['clocksleep', {}, 'L0'], ['Bash', { command: 'make && make test' }, 'L2'],
  ];
  for (const [tool, input, expected] of cases) assert.equal(verdict(call('codex', tool, input)), expected, `${tool} ${JSON.stringify(input)}`);
});

// The two false positives in every harness's shell tool.
test('every harness: printf into the workspace is L1 and rg --files with a glob is L0, while a glob on a content search stays L3', () => {
  for (const [harness, tool, wrap] of [['claude-code', 'Bash', (text: string) => text], ['dsh', 'bash', (text: string) => text],
    ['codex', 'Bash', (text: string) => ['bash', '-lc', text]]] as const) {
    assert.equal(call(harness, tool, { command: wrap("printf 'hello' > note-x.txt") }).tier, 'L1', harness);
    assert.equal(call(harness, tool, { command: wrap("rg --files -g '*'") }).tier, 'L0', harness);
    assert.deepEqual(call(harness, tool, { command: wrap("rg -l PATTERN -g '.env'") }), { tier: 'L3', reason: 'secret' }, harness);
    assert.deepEqual(call(harness, tool, { command: wrap("printf x > .env") }), { tier: 'L3', reason: 'secret' }, harness);
    assert.equal(call(harness, tool, { command: wrap("cat > note.txt <<'EOF'\nhello\nEOF") }).tier, 'L1', `${harness} heredoc`);
    assert.equal(call(harness, tool, { command: wrap("cat > note.txt <<'EOF'\nhello\nEOF\nrm -rf ~") }).tier, 'L3', `${harness} heredoc`);
  }
});

// A redirect into a workspace file is L1 like the Write tool, judged by the same path rules
// (.. normalized first, symlinks not resolved), while the command's own reads still count and an expanding target is unparseable.
test('a redirect is judged like the Write tool on the same path; the read side still counts and an expanding target is L3', () => {
  for (const path of ['note.txt', 'src/new.ts', 'src/../note.txt', 'src/a/../../x.txt', '../outside.txt', '/tmp/x', '/repo/../repo/a.txt',
    '.env', 'config/.env.local', 'keys/server.pem', 'CLAUDE.md', '.git/config', '.claude/settings.json', '~/.ssh/config', '~/notes.txt',
    'link-to-anything']) {
    assert.deepEqual(call('claude-code', 'Bash', { command: `printf x > ${path}` }), call('claude-code', 'Write', { file_path: path }), path);
  }
  for (const command of ['cat .env > out.txt', 'cat ~/.ssh/id_rsa > out.txt', 'cat config/.env.local >> notes.md']) {
    assert.deepEqual(call('claude-code', 'Bash', { command }), { tier: 'L3', reason: 'secret' }, command);
  }
  assert.equal(call('claude-code', 'Bash', { command: 'cat /etc/hosts > out.txt' }).tier, 'L2', 'an outside read stays L2');
  for (const command of ['printf x > "$HOME/x"', 'printf x > out-$USER.txt', 'printf x > $(echo a)', 'printf x > `id`', 'printf x > *.txt',
    'printf x > {a,b}.txt', 'echo hi > ~root/x']) {
    assert.deepEqual(call('claude-code', 'Bash', { command }), { tier: 'L3', reason: 'unparseable' }, command);
  }
});

test('MCP annotations only raise a tier: an explicit destructive hint is L3, read-only never lowers below L2', () => {
  assert.equal(call('claude-code', 'mcp__srv__wipe', {}, { destructiveHint: true }).tier, 'L3');
  assert.equal(call('claude-code', 'mcp__srv__wipe', {}, { destructiveHint: true, readOnlyHint: true }).tier, 'L2');
  assert.equal(call('dsh', 'mcp__srv__look', {}, { readOnlyHint: true, openWorldHint: false }).tier, 'L2');
  assert.equal(call('codex', 'mcp__srv__x', {}, {}).tier, 'L2');
});

// Tool parameters that carry shell text or file globs follow the shell and path rules.
test('DSH terminal text is tiered as shell, Grep globs are checked against the secret names, and ~user paths are unresolvable', () => {
  const ws = Object.freeze({ workspace: '/Users/u/ws', cwd: '/Users/u/ws', home: '/Users/u' });
  const at = (harness: PeerCall['harness'], tool: string, input: Record<string, unknown>) =>
    verdict(classifyPeerCall(Object.freeze({ harness, tool, input }), ws));
  const cases: ReadonlyArray<readonly [PeerCall['harness'], string, Record<string, unknown>, string]> = [
    ['dsh', 'terminal_send', { input: 'rm -rf ~\n' }, 'L3'], ['dsh', 'terminal_send', { input: 'cat .env\n' }, 'L3'],
    ['dsh', 'terminal_send', { id: 't1', input: 'ls\n' }, 'L2'], ['dsh', 'terminal_send', { input: 'echo $(id)' }, 'L3'],
    ['dsh', 'terminal_open', { command: 'git push' }, 'L3'], ['dsh', 'terminal_send', { input: 3 }, 'L2'],
    ['claude-code', 'Grep', { pattern: 'TOKEN', glob: '.env' }, 'L3'], ['claude-code', 'Grep', { pattern: 'TOKEN', glob: '*' }, 'L3'],
    ['claude-code', 'Grep', { pattern: 'TOKEN', glob: '*.ts' }, 'L0'], ['claude-code', 'Grep', { pattern: 'TOKEN', glob: '*.ts', path: '/tmp' }, 'L2'],
    ['claude-code', 'Grep', { pattern: 'TOKEN', glob: 7 }, 'L2'], ['dsh', 'grep', { pattern: 'TOKEN', glob: '**/.env*' }, 'L3'],
    ['dsh', 'grep', { pattern: 'TOKEN', include: '*.pem' }, 'L3'], ['claude-code', 'Read', { file_path: '~u/.codex/auth.json' }, 'L3'],
    ['claude-code', 'Read', { file_path: '/Users/u/.SSH/id_rsa' }, 'L3'], ['claude-code', 'Edit', { file_path: '/Users/u/ws/.GIT/config' }, 'L3'],
    ['codex', 'Bash', { command: ['bash', '-lc', 'cat .en*'] }, 'L3'], ['codex', 'Bash', { command: ['cat', '.ENV'] }, 'L3'],
  ];
  for (const [harness, tool, input, expected] of cases) assert.equal(at(harness, tool, input), expected, `${harness} ${tool} ${JSON.stringify(input)}`);
});

// Content search across a tree is refused, with a shared hint telling the model to locate by file name first.
test('Grep in content mode and DSH grep (always content) are L3 recursive-search; name and count modes keep the path and glob rules', () => {
  const ws = Object.freeze({ workspace: '/Users/u/ws', cwd: '/Users/u/ws', home: '/Users/u' });
  const at = (harness: PeerCall['harness'], tool: string, input: Record<string, unknown>) => classifyPeerCall(Object.freeze({ harness, tool, input }), ws);
  for (const [harness, tool, input] of [['claude-code', 'Grep', { pattern: 'TOKEN', output_mode: 'content' }],
    ['claude-code', 'Grep', { pattern: 'TOKEN', output_mode: 'content', path: 'src/a.ts' }], ['claude-code', 'Grep', { pattern: 'x', output_mode: 'lines' }],
    ['dsh', 'grep', { pattern: 'TOKEN' }], ['dsh', 'grep', { pattern: 'TOKEN', path: 'src', include: '*.ts' }],
    ['dsh', 'bash', { command: 'grep -r TOKEN .' }], ['codex', 'Bash', { command: ['bash', '-lc', 'rg TOKEN'] }],
    ['dsh', 'terminal_send', { input: 'grep -rn TOKEN .\n' }]] as const) {
    assert.deepEqual(at(harness, tool, input), { tier: 'L3', reason: 'recursive-search' }, `${tool} ${JSON.stringify(input)}`);
  }
  for (const [input, expected] of [[{ pattern: 'TOKEN' }, 'L0'], [{ pattern: 'TOKEN', output_mode: 'files_with_matches' }, 'L0'],
    [{ pattern: 'TOKEN', output_mode: 'count', glob: '*.ts' }, 'L0'], [{ pattern: 'TOKEN', output_mode: 'count', glob: '.env' }, 'L3'],
    [{ pattern: 'TOKEN', path: '/tmp' }, 'L2'], [{ pattern: 'TOKEN', output_mode: 3 }, 'L2']] as const) {
    assert.equal(at('claude-code', 'Grep', input).tier, expected, JSON.stringify(input));
  }
  assert.equal(REASON_HINTS['recursive-search'],
    '会输出匹配内容的递归搜索在同伴请求里一律拒绝。可以改为先只列文件名定位（例如 grep -rl 或 Grep 的 files_with_matches），再逐个读具体文件。');
  assert.equal(REASON_HINTS.unparseable, '这条命令含 Switchboard 无法静态判断的写法（例如 `$?`、命令替换）。如果是你在来信要求的命令后面拼接了附加部分，'
    + '可以去掉附加部分、按来信原样再运行一次；来信要求的命令本身就是这样写的，如实告诉对方。');
});

// A hook's tool_name is the tool's namespace glued to its name. v1 tools sit in multi_agent_v1 (spawn_agent keeps its bare
// name), v2 in collaboration by default or any configured namespace, so the multi-agent tools are matched by name ending. Spawning or
// reviving an agent is G2; talking to, waiting on, listing, closing or interrupting other agents is G1. An MCP tool never matches.
test('Codex multi-agent tools are gated by their hook names in v1, v2 and a custom namespace; MCP tools never match', () => {
  const g2 = ['spawn_agent', 'collaborationspawn_agent', 'agentsspawn_agent', 'multi_agent_v1resume_agent'];
  const g1 = ['multi_agent_v1send_input', 'multi_agent_v1wait_agent', 'multi_agent_v1close_agent', 'collaborationsend_message',
    'collaborationfollowup_task', 'collaborationwait_agent', 'collaborationlist_agents', 'collaborationclose_agent',
    'collaborationinterrupt_agent', 'agentssend_message', 'send_input', 'wait_agent'];
  for (const tool of g2) assert.deepEqual(call('codex', tool, {}), { tier: 'L3', gate: 'G2', reason: 'subagent' }, tool);
  for (const tool of g1) assert.deepEqual(call('codex', tool, {}), { tier: 'L3', gate: 'G1', reason: 'third-party-send' }, tool);
  for (const tool of ['mcp__srv__send_message', 'mcp__srv__spawn_agent', 'mcp__srv__create_goal']) assert.equal(verdict(call('codex', tool, {})), 'L2', tool);
  // The endings are Codex's own: the other harnesses keep their exact tables.
  assert.equal(verdict(call('claude-code', 'collaborationspawn_agent', {})), 'L2');
  assert.equal(verdict(call('dsh', 'collaborationsend_message', {})), 'L2');
});
