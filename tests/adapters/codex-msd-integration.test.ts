// INPUT: The in-process msd (switchboard + control server), a synthetic Claude contact, fake Codex lock holders and queue.
// OUTPUT: Contract regressions for the Codex bridge against the real adapter channel: register, one-step send, inbound, reply, owner-offline, auto,
//         and an act letter msd verifies opening the turn the hook tools gate with the attached preset.
// POS: Offline integration test of the Codex bridge with a real msd; no real Codex host, Claude inbox or model.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSwitchboard } from '../../src/daemon/switchboard.ts';
import { listenControl } from '../../src/daemon/control-server.ts';
import { createConfigStore, createControlMethods } from '../../src/daemon/control-methods.ts';
import { writeDaemonConfig, type DaemonConfig } from '../../src/daemon/config.ts';
import { runPaths } from '../../src/daemon/paths.ts';
import { createCodexBridge } from '../../src/adapters/codex/bridge.ts';
import { type QueueSession } from '../../src/adapters/codex/app-server-queue.ts';
import { type Envelope } from '../../src/protocol/message.ts';

const THREAD = '01a1582e-3c00-7e81-9a44-3059358af07c';
const META = { threadId: THREAD };
const pin = (name: string, digit: string) => ({ path: `/opt/${name}`, sha256: digit.repeat(64) });

async function setup(autoCodex = false, codexMode: 'direct' | 'act' = 'direct') {
  const config: DaemonConfig = Object.freeze({ schemaVersion: 4, python: pin('python', 'a'),
    claude: { wrapperPins: [] },
    autoRegister: { 'claude-code': false, dsh: false, codex: autoCodex }, autoRegisterProjects: [],
    replyMode: { 'claude-code': 'direct', dsh: 'direct', codex: codexMode } as const,
  actPreset: { 'claude-code': 'workspace-write', dsh: 'workspace-write', codex: 'workspace-write' } as const, linkBudget: { windowSeconds: 600, maxPushes: 30 } });
  const root = await mkdtemp(join(tmpdir(), 'msd-codex-'));
  const paths = runPaths(root); await mkdir(paths.run, { mode: 0o700 });
  await writeDaemonConfig(paths.config, config);
  const board = createSwitchboard();
  const store = createConfigStore(paths.config, config, next => board.setBudget(next.linkBudget));
  const dispatch = createControlMethods({ board, config: store, version: 't', startedAt: '2026-10-20T00:00:00.000Z',
    projectOf: async cwd => cwd });
  const server = await listenControl(paths.control, dispatch);
  const claudeInbox: Envelope[] = [];
  const claude = board.register({ harness: 'claude-code', sessionId: 'claude-1', clientSurface: 'cli', title: '审查会话',
    cwd: '/repo/a', project: '/repo/a', push: async frame => { claudeInbox.push(frame); return { state: 'dispatched', transport: null }; },
    verify: async () => {}, notice: async () => {} });
  const queued: string[] = [];
  const openQueue = async (): Promise<QueueSession> => ({ close: () => {}, remove: async () => true,
    add: async (_thread, text, id) => { queued.push(text); return { id: 'q-1', clientUserMessageId: id }; } });
  const owner = { pid: 42 };
  const bridge = createCodexBridge({ socketPath: paths.control, codexHome: '/c', ownerPid: 42, surface: 'cli', cwd: '/repo/c',
    instanceId: 'codex-int', reconnectMs: 20, openQueue, listHolders: async () => [owner.pid], projectOf: async () => '/repo/c',
    home: '/Users/u', hooksTrusted: async () => true });
  const close = async () => { bridge.close(); await server.close(); };
  return { board, bridge, claude, claudeInbox, queued, owner, close };
}

test('Codex registers, sends one-step to Claude, receives inbound and replies on the original link', async () => {
  const f = await setup();
  try {
    const registered = await f.bridge.call('router_register', {}, META);
    assert.deepEqual(registered, { isError: false, value: { harness: 'codex', sessionId: THREAD, registered: true, project: '/repo/c' } });
    assert.equal(f.board.list({ harness: 'codex' })[0].sessionId, THREAD);
    const listed = await f.bridge.call('router_list_sessions', {}, META);
    assert.deepEqual((listed.value as Array<{ sessionId: string }>).map(row => row.sessionId), ['claude-1']);
    const sent = await f.bridge.call('router_send', { harness: 'claude-code', target: '审查会话', body: ' 原样\n' }, META);
    assert.equal(sent.isError, false);
    assert.equal((sent.value as { sent: boolean }).sent, true);
    assert.equal(f.claudeInbox.length, 1);
    assert.equal(f.claudeInbox[0].body, ' 原样\n');
    assert.equal(f.claudeInbox[0].sender.nativeSessionId, THREAD);
    const inbound = await f.board.send({ harness: 'claude-code', sessionId: 'claude-1', generation: f.claude.generation },
      { harness: 'codex', target: THREAD, body: '你好 Codex' });
    assert.equal(inbound.sent, true);
    assert.equal(inbound.sent && inbound.receipt.state, 'dispatched');
    assert.equal(f.queued.length, 1);
    assert.ok(f.queued[0].startsWith('来源：Claude Code | Agent Message Switchboard · 会话 "审查会话"\n'));
    assert.ok(f.queued[0].endsWith('以下为原样正文：\n你好 Codex'));
    const inReplyTo = inbound.sent ? inbound.receipt.messageId : '';
    const replied = await f.bridge.call('router_reply', { inReplyTo, body: '收到' }, META);
    assert.equal(replied.isError, false);
    assert.equal(f.claudeInbox.at(-1)!.body, '收到');
    assert.equal(f.claudeInbox.at(-1)!.inReplyTo, inReplyTo);
    assert.deepEqual(await f.bridge.call('router_send', { harness: 'codex', target: THREAD, body: 'x' }, META),
      { isError: true, value: { error: 'USE_NATIVE_TOOLS' } });
  } finally { await f.close(); }
});

test('sending registers the Codex caller first, and an exited Codex MCP process makes the session TARGET_OFFLINE', async () => {
  const f = await setup();
  try {
    const sent = await f.bridge.call('router_send', { harness: 'claude-code', target: 'claude-1', body: 'x' }, META);
    assert.equal((sent.value as { sent: boolean }).sent, true);
    assert.deepEqual(f.board.list({ harness: 'codex' }).map(row => [row.sessionId, row.online]), [[THREAD, true]]);
    const back = await f.board.send({ harness: 'claude-code', sessionId: 'claude-1', generation: f.claude.generation },
      { harness: 'codex', target: THREAD, body: '回信' });
    assert.equal(back.sent && back.receipt.state, 'dispatched');
    f.bridge.close();
    for (let tries = 0; f.board.list({ harness: 'codex' })[0].online && tries < 100; tries += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(f.board.list({ harness: 'codex' })[0].online, false);
    await assert.rejects(f.board.send({ harness: 'claude-code', sessionId: 'claude-1', generation: f.claude.generation },
      { harness: 'codex', target: THREAD, body: 'late' }), /TARGET_OFFLINE/);
    assert.equal(f.queued.length, 1);
  } finally { await f.close(); }
});

test('an owner that dropped the writer lock is reported TARGET_OFFLINE without queueing, and the same message can resend', async () => {
  const f = await setup();
  try {
    await f.bridge.call('router_register', {}, META);
    const sender = { harness: 'claude-code' as const, sessionId: 'claude-1', generation: f.claude.generation };
    f.owner.pid = 7;
    await assert.rejects(f.board.send(sender, { harness: 'codex', target: THREAD, messageId: 'm-off', body: '在吗' }), /TARGET_OFFLINE/);
    assert.equal(f.queued.length, 0);
    assert.equal(f.board.list({ harness: 'codex' })[0].online, true);
    f.owner.pid = 42;
    const again = await f.board.send(sender, { harness: 'codex', target: THREAD, messageId: 'm-off', body: '在吗' });
    assert.equal(again.sent && again.receipt.state, 'dispatched');
    assert.equal(f.queued.length, 1);
  } finally { await f.close(); }
});

test('a Codex session taken offline by ms keeps its project when the next send re-registers it implicitly', async () => {
  const f = await setup();
  try {
    await f.bridge.call('router_register', {}, META);
    f.board.unregister({ harness: 'codex', sessionId: THREAD });
    assert.equal(f.board.list({ harness: 'codex' })[0].online, false);
    const sent = await f.bridge.call('router_send', { harness: 'claude-code', target: 'claude-1', body: 'x' }, META);
    assert.equal((sent.value as { sent: boolean }).sent, true);
    const row = f.board.list({ harness: 'codex' })[0];
    assert.deepEqual([row.online, row.cwd, row.project, row.clientSurface], [true, '/repo/c', '/repo/c', 'cli']);
  } finally { await f.close(); }
});

test('SessionStart auto registration follows the msd codex switch', async () => {
  const off = await setup(false);
  try {
    await off.bridge.call('router_session_start', { source: 'startup', cwd: '/repo/c' }, META);
    assert.deepEqual(off.board.list({ harness: 'codex' }), []);
  } finally { await off.close(); }
  const on = await setup(true);
  try {
    await on.bridge.call('router_session_start', { source: 'resume', cwd: '/repo/c' }, META);
    assert.equal(on.board.list({ harness: 'codex' })[0].online, true);
  } finally { await on.close(); }
});

test('under act a letter msd verifies opens its turn: the hooks gate by the attached preset, also after later turns', async () => {
  const f = await setup(false, 'act');
  try {
    await f.bridge.call('router_register', {}, META);
    const sent = await f.board.send({ harness: 'claude-code', sessionId: 'claude-1', generation: f.claude.generation },
      { harness: 'codex', target: THREAD, body: '请跑测试' });
    assert.equal(sent.sent, true);
    const hook = { prompt: f.queued[0], turn_id: 'turn-letter', permission_mode: 'default' };
    assert.deepEqual(await f.bridge.call('router_prompt_command', hook, META), { isError: false, value: { hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit', additionalContext: 'Switchboard 回复档位：act' } } });
    const tool = (command: string) => ({ turn_id: 'turn-letter', tool_name: 'Bash', tool_input: { command }, cwd: '/repo/c' });
    assert.deepEqual(await f.bridge.call('router_pre_tool_use', tool('ls'), META), { isError: false, value: undefined });
    const denied = await f.bridge.call('router_pre_tool_use', tool('npm test'), META);
    assert.match((denied.value as any).hookSpecificOutput.permissionDecisionReason,
      /^Switchboard 同伴请求（Claude Code 会话 "审查会话"）：执行命令，按「工作区内修改」预设需要审批，Codex 不为同伴请求弹审批，已拒绝。/);
    // A code-mode cell may keep calling tools under this turn_id after the turn is over, so nothing ends it.
    assert.deepEqual(await f.bridge.call('router_prompt_command', { ...hook, prompt: '普通问题', turn_id: 'turn-user' }, META),
      { isError: false, value: undefined });
    assert.notDeepEqual(await f.bridge.call('router_pre_tool_use', tool('npm test'), META), { isError: false, value: undefined });
    // The same letter verified twice is refused by msd (once per messageId), so a replayed prompt opens nothing.
    assert.deepEqual(await f.bridge.call('router_prompt_command', { ...hook, turn_id: 'turn-replay' }, META), { isError: false, value: undefined });
    assert.deepEqual(await f.bridge.call('router_pre_tool_use', { ...tool('npm test'), turn_id: 'turn-replay' }, META),
      { isError: false, value: undefined });
  } finally { await f.close(); }
});
