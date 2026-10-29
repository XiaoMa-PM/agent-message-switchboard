// INPUT: Synthetic argv/env, a fake msd root, a temp Codex home and fake `codex <subcommand>` parent processes.
// OUTPUT: Regressions for entry options, real lsof/ps parent binding, attaching to msd on start and the exec-server refusal
//         that never contacts msd, / menu skill link included (macOS only).
// POS: Offline entry test; the test process or a node symlink plays the Codex parent, so it is not real Codex host evidence.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdir, mkdtemp, open, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { type Readable, type Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parseMainOptions, REMOTE_ENVIRONMENT_NOTE } from '../../src/adapters/codex/mcp-main.ts';
import { CODEX_TOOLS } from '../../src/adapters/codex/mcp-server.ts';
import { startFakeMsd } from '../helpers/fake-msd.ts';

const THREAD = '01a1582e-3c00-7e81-9a44-3059358af07c';
const MAIN = fileURLToPath(new URL('../../src/adapters/codex/mcp-main.ts', import.meta.url));
const PARENT = fileURLToPath(new URL('../helpers/fake-codex-parent.ts', import.meta.url));
const darwinOnly = { skip: process.platform !== 'darwin' };
type Entry = ChildProcessByStdio<Writable, Readable, null>;

test('entry options default to the msd root and ~/.codex, accepting only absolute overrides', () => {
  assert.deepEqual(parseMainOptions([], {}, '/Users/u'),
    { root: '/Users/u/Library/Application Support/agent-message-switchboard', codexHome: '/Users/u/.codex' });
  assert.deepEqual(parseMainOptions(['--root', '/r'], { CODEX_HOME: '/ch' }, '/Users/u'), { root: '/r', codexHome: '/ch' });
  assert.deepEqual(parseMainOptions([], { CODEX_HOME: '' }, '/h'), { root: '/h/Library/Application Support/agent-message-switchboard', codexHome: '/h/.codex' });
  assert.throws(() => parseMainOptions(['--root'], {}, '/h'), /INVALID_ARGUMENTS/);
  assert.throws(() => parseMainOptions(['--root', 'rel'], {}, '/h'), /INVALID_ARGUMENTS/);
  assert.throws(() => parseMainOptions(['--other', '/x'], {}, '/h'), /INVALID_ARGUMENTS/);
  assert.throws(() => parseMainOptions([], { CODEX_HOME: 'rel' }, '/h'), /INVALID_CODEX_HOME/);
});

function rpcOver(child: Entry) {
  const replies = new Map<number, Record<string, any>>();
  const waiting = new Map<number, () => void>();
  createInterface({ input: child.stdout }).on('line', line => {
    const reply = JSON.parse(line); replies.set(reply.id, reply); waiting.get(reply.id)?.();
  });
  return (id: number, method: string, params: unknown) => new Promise<Record<string, any>>(resolve => {
    waiting.set(id, () => resolve(replies.get(id)!));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

async function stop(child: Entry): Promise<void> {
  child.stdin.end();
  if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
}

// A node symlink named `codex` running a script named after the subcommand: ps shows `<dir>/codex <subcommand> ...`.
async function spawnUnderFakeCodex(subcommand: string, args: string[], env: NodeJS.ProcessEnv) {
  const dir = await mkdtemp('/tmp/ms-fake-codex-');
  await symlink(process.execPath, join(dir, 'codex'));
  await symlink(PARENT, join(dir, subcommand));
  const child = spawn(join(dir, 'codex'), [subcommand, ...args], { cwd: dir, env, stdio: ['pipe', 'pipe', 'inherit'] });
  return { child, dir };
}

async function codexHomeWithLock() {
  const codexHome = await mkdtemp('/tmp/ms-codex-home-');
  await mkdir(join(codexHome, 'thread-writer-locks'));
  const lockPath = join(codexHome, 'thread-writer-locks', `${THREAD}.lock`);
  await (await open(lockPath, 'w')).close();
  return { codexHome, lockPath };
}

test('stdio entry binds _meta.threadId to the parent holding that writer lock', darwinOnly, async () => {
  const msd = await startFakeMsd();
  const codexHome = await mkdtemp('/tmp/ms-codex-home-');
  await mkdir(join(codexHome, 'thread-writer-locks'));
  const lock = await open(join(codexHome, 'thread-writer-locks', `${THREAD}.lock`), 'w');
  const child = spawn(process.execPath, [MAIN, '--root', msd.root], { env: { ...process.env, CODEX_HOME: codexHome },
    stdio: ['pipe', 'pipe', 'inherit'] });
  const rpc = rpcOver(child);
  try {
    await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    const ok = await rpc(2, 'tools/call', { name: 'router_register', arguments: {}, _meta: { threadId: THREAD } });
    assert.equal(ok.result.isError, false, JSON.stringify(ok));
    assert.deepEqual(msd.requests.find(request => request.method === 'register')!.params,
      { sessionId: THREAD, cwd: process.cwd(), clientSurface: 'cli', mode: 'manual' });
    const other = await rpc(3, 'tools/call', { name: 'router_register', arguments: {},
      _meta: { threadId: '01a1582e-3c00-7e81-9a44-3059358af07d' } });
    assert.deepEqual(JSON.parse(other.result.content[0].text), { error: 'IDENTITY_MISMATCH' });
  } finally {
    await stop(child);
    await lock.close(); await rm(codexHome, { recursive: true, force: true }); await msd.close();
  }
});

test('a codex app-server parent holding the lock still registers normally', darwinOnly, async () => {
  const msd = await startFakeMsd();
  const { codexHome, lockPath } = await codexHomeWithLock();
  const { child, dir } = await spawnUnderFakeCodex('app-server', ['--listen', 'stdio://'], { ...process.env,
    CODEX_HOME: codexHome, MS_FAKE_HOLD: lockPath, MS_FAKE_CHILD: JSON.stringify([MAIN, '--root', msd.root]) });
  const rpc = rpcOver(child);
  try {
    await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    const ok = await rpc(2, 'tools/call', { name: 'router_register', arguments: {}, _meta: { threadId: THREAD } });
    assert.equal(ok.result.isError, false, JSON.stringify(ok));
    assert.equal(msd.requests.find(request => request.method === 'register')!.params.sessionId, THREAD);
  } finally {
    await stop(child);
    await rm(dir, { recursive: true, force: true }); await rm(codexHome, { recursive: true, force: true }); await msd.close();
  }
});

// The local MCP process attaches on start, so msd counts an open Codex session before the
// host sends initialize or any tool call.
test('a local Codex MCP process attaches to msd as soon as it starts, before initialize or any tool call', darwinOnly, async () => {
  const msd = await startFakeMsd();
  const { codexHome, lockPath } = await codexHomeWithLock();
  const { child, dir } = await spawnUnderFakeCodex('app-server', ['--listen', 'stdio://'], { ...process.env,
    CODEX_HOME: codexHome, MS_FAKE_HOLD: lockPath, MS_FAKE_CHILD: JSON.stringify([MAIN, '--root', msd.root]) });
  try {
    const attach = await msd.waitFor('adapter.attach');
    assert.equal(attach.harness, 'codex');
    assert.match(attach.instanceId, /^codex:[0-9a-f-]{36}$/);
    assert.deepEqual(msd.requests.map(request => request.method), ['adapter.attach']);
  } finally {
    await stop(child);
    await rm(dir, { recursive: true, force: true }); await rm(codexHome, { recursive: true, force: true }); await msd.close();
  }
});

test('under a codex exec-server parent tools refuse with the fixed code, SessionStart stays silent and msd is never contacted',
  darwinOnly, async () => {
  const msd = await startFakeMsd();
  const { codexHome, lockPath } = await codexHomeWithLock();
  const { child, dir } = await spawnUnderFakeCodex('exec-server',
    ['--remote', 'https://example.invalid/api', '--environment-id', 'env_1'], { ...process.env,
      CODEX_HOME: codexHome, MS_FAKE_HOLD: lockPath, MS_FAKE_CHILD: JSON.stringify([MAIN, '--root', msd.root]) });
  const rpc = rpcOver(child);
  const args: Record<string, unknown> = { router_send: { harness: 'dsh', target: 'd', body: 'b' },
    router_reply: { inReplyTo: 'm', body: 'b' } };
  try {
    await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    const listed = await rpc(2, 'tools/list', {});
    assert.deepEqual(listed.result.tools.map((tool: { name: string }) => tool.name), CODEX_TOOLS.map(tool => tool.name));
    let id = 3;
    const hookTools = ['router_session_start', 'router_prompt_command', 'router_pre_tool_use', 'router_permission_request', 'router_turn_end'];
    for (const tool of CODEX_TOOLS.filter(tool => !hookTools.includes(tool.name))) {
      const reply = await rpc(id++, 'tools/call', { name: tool.name, arguments: args[tool.name] ?? {}, _meta: { threadId: THREAD } });
      assert.equal(reply.result.isError, true, tool.name);
      assert.deepEqual(JSON.parse(reply.result.content[0].text),
        { error: 'UNSUPPORTED_CODEX_REMOTE_ENVIRONMENT', note: REMOTE_ENVIRONMENT_NOTE }, tool.name);
    }
    // The SessionStart hook result stays empty, like every other hook failure, so new threads show no hook error.
    const hook = await rpc(id++, 'tools/call', { name: 'router_session_start', arguments: { source: 'startup' },
      _meta: { threadId: THREAD } });
    assert.deepEqual(hook.result, { content: [], isError: false });
    // No letter reaches a Local Work thread, so the act hooks answer nothing instead of a Hook failed on every tool call.
    for (const [name, args] of [['router_pre_tool_use', { turn_id: 't', tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/x' }],
      ['router_permission_request', { turn_id: 't' }], ['router_turn_end', { turn_id: 't', hook_event_name: 'Stop' }]] as const) {
      const reply = await rpc(id++, 'tools/call', { name, arguments: args, _meta: { threadId: THREAD } });
      assert.deepEqual(reply.result, { content: [], isError: false }, name);
    }
    // UserPromptSubmit: ordinary prompts pass silently; a typed command is blocked with the fixed refusal, never sent to the model.
    const ordinary = await rpc(id++, 'tools/call', { name: 'router_prompt_command', arguments: { prompt: '你好' }, _meta: { threadId: THREAD } });
    assert.deepEqual(ordinary.result, { content: [], isError: false });
    const typed = await rpc(id++, 'tools/call', { name: 'router_prompt_command', arguments: { prompt: '$ms-register' }, _meta: { threadId: THREAD } });
    assert.equal(typed.result.isError, false);
    assert.deepEqual(JSON.parse(typed.result.content[0].text), { decision: 'block', reason: 'Switchboard 登记失败（UNSUPPORTED_CODEX_REMOTE_ENVIRONMENT）：'
      + 'ChatGPT 的 Local Work（云端驱动、本机执行）线程不支持 Switchboard，请改用 Codex 标签页的本地线程或 Codex CLI；本提示未发送给模型。' });
    // The / menu skill link is matched against the same CODEX_HOME the process got, so it is refused the same way.
    const link = `[$ms:ms-register](${codexHome}/plugins/cache/ms-local/ms/0.1.0-x/skills/ms-register/SKILL.md) \n`;
    const menu = await rpc(id++, 'tools/call', { name: 'router_prompt_command', arguments: { prompt: link }, _meta: { threadId: THREAD } });
    assert.deepEqual(JSON.parse(menu.result.content[0].text), JSON.parse(typed.result.content[0].text));
    assert.match(REMOTE_ENVIRONMENT_NOTE, /Local Work/);
    assert.deepEqual(msd.requests, []);
  } finally {
    await stop(child);
    await rm(dir, { recursive: true, force: true }); await rm(codexHome, { recursive: true, force: true }); await msd.close();
  }
});
