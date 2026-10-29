// INPUT: The real Cordis 4 Context, DSH AgentRegistry and SystemPrompt registry, stub host services, a fake app bundle, an in-process msd.
// OUTPUT: Realistic-host regression: after dispose/re-apply cycles, /ms-auto and /ms-register work and the context follows /ms-reply.
// POS: Offline DSH plugin test closer to the desktop host than the synthetic ctx; no real DSH, SDK or model.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { AgentRegistry } from '@deepseek-ai/dsh-agent';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { startDshPlugin } from '../../src/adapters/dsh/daemon-plugin.ts';
import { createSwitchboard } from '../../src/daemon/switchboard.ts';
import { listenControl } from '../../src/daemon/control-server.ts';
import { createConfigStore, createControlMethods } from '../../src/daemon/control-methods.ts';
import { writeDaemonConfig, type DaemonConfig } from '../../src/daemon/config.ts';
import { runPaths } from '../../src/daemon/paths.ts';

type Command = { name: string; handler: (invocation: { agent: unknown; rawInput: string }) => Promise<{ kind: string; text: string }> };
const SDK = 'Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-llm';
const pin = (name: string, digit: string) => ({ path: `/opt/${name}`, sha256: digit.repeat(64) });
const config: DaemonConfig = Object.freeze({ schemaVersion: 4, python: pin('python', 'a'), claude: { wrapperPins: [] },
  autoRegister: { 'claude-code': false, dsh: false, codex: false }, autoRegisterProjects: [],
  replyMode: { 'claude-code': 'direct', dsh: 'direct', codex: 'direct' } as const,
  actPreset: { 'claude-code': 'workspace-write', dsh: 'workspace-write', codex: 'workspace-write' } as const, linkBudget: { windowSeconds: 600, maxPushes: 30 } });
const until = async (check: () => boolean) => {
  for (let index = 0; index < 400 && !check(); index++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(check());
};

async function host() {
  const base = await mkdtemp(join(tmpdir(), 'ms-cordis-'));
  const root = join(base, 'root'); const app = join(base, 'app'); const profile = join(base, 'profile');
  await mkdir(root, { mode: 0o700 }); await mkdir(profile); await mkdir(join(app, 'Contents'), { recursive: true });
  await writeFile(join(app, 'Contents/Info.plist'), '<dict>\n<key>CFBundleShortVersionString</key>\n<string>0.2.1-rc.2</string>\n</dict>\n');
  await mkdir(join(app, SDK, 'lib'), { recursive: true });
  await writeFile(join(app, SDK, 'package.json'), '{"type":"module"}\n');
  await writeFile(join(app, SDK, 'lib/index.js'), "export const createUserMessage = input => ({ id: 'sdk', role: 'user', ...input });\n");
  const paths = runPaths(root); await mkdir(paths.run, { recursive: true, mode: 0o700 });
  await writeDaemonConfig(paths.config, config);
  const board = createSwitchboard();
  const store = createConfigStore(paths.config, config, next => board.setBudget(next.linkBudget));
  const server = await listenControl(paths.control, createControlMethods({ board, config: store, version: 't',
    startedAt: '2026-10-22T00:00:00.000Z', projectOf: async cwd => cwd }));
  const ctx = new Context();
  await (ctx.plugin as unknown as (plugin: unknown) => Promise<unknown>).call(ctx, AgentRegistry);
  await (ctx.plugin as unknown as (plugin: unknown, config: unknown) => Promise<unknown>).call(ctx, SystemPrompt, {});
  const prompt = (ctx as unknown as { systemPrompt: SystemPrompt }).systemPrompt;
  const commands = new Map<string, Command>();
  await ctx.plugin({ name: 'host-stubs', apply(scoped: Context) {
    scoped.provide('tools' as never, { register: () => () => {} } as never);
    scoped.provide('profileContext' as never, { name: 'desktop', dir: profile } as never);
    scoped.provide('workspaceRegistry' as never, { archivedSessionIds: [] } as never);
    scoped.provide('sessionTitle' as never, { get: () => ({ title: '标题' }) } as never);
    scoped.provide('commands' as never, { register: (command: Command) => {
      commands.set(command.name, command); return () => { if (commands.get(command.name) === command) commands.delete(command.name); };
    } } as never);
  } } as never, undefined as never);
  const agents = (ctx as unknown as { agents: { enter: (agent: unknown, owner: undefined) => unknown;
    announce: (agent: unknown, source: string) => Promise<void> } }).agents;
  const live = async (id: string) => {
    const agent = { id, session: { id, header: { id, cwd: `/repo/${id}` } }, ctx, followup: () => {} };
    agents.enter(agent, undefined); await agents.announce(agent, 'startup');
    return agent;
  };
  const plugin = { name: 'agent-message-switchboard', inject: ['agents', 'tools', 'profileContext', 'workspaceRegistry', 'sessionTitle'],
    apply: (scoped: unknown, value: unknown) => startDshPlugin(scoped as never, value, { app, pid: 4242, retryMs: 20 }) };
  const beacon = () => { try { return JSON.parse(readFileSync(join(paths.run, 'dsh-plugin.json'), 'utf8')); } catch { return undefined; } };
  // Every instance writes the same beacon path, so the previous instance's "ready" must not stand in for this one's attach.
  const load = async () => {
    rmSync(join(paths.run, 'dsh-plugin.json'), { force: true });
    const fiber = await ctx.plugin(plugin as never, { root } as never);
    await until(() => beacon()?.state === 'ready' && commands.has('ms-auto'));
    return fiber as unknown as { dispose: () => Promise<void> };
  };
  const close = async () => { await (ctx as unknown as { fiber: { dispose: () => Promise<void> } }).fiber.dispose(); await server.close(); };
  const modeLine = async () => (await prompt.assemble()).contexts.find(item => item.name === 'agent-message-switchboard:reply-mode')?.text;
  return { board, commands, live, load, close, beacon, prompt, modeLine };
}

test('after two plugin dispose/re-apply cycles /ms-auto on registers the live agent, /ms-register works, a new agent auto-registers', async () => {
  const h = await host();
  try {
    const open = await h.live('S1');
    let fiber = await h.load();
    for (let cycle = 0; cycle < 2; cycle++) {
      await fiber.dispose();
      assert.equal(h.commands.size, 0);
      fiber = await h.load();
    }
    const on = await h.commands.get('ms-auto')!.handler({ agent: open, rawInput: ' on' });
    assert.equal(on.kind, 'success', on.text);
    await until(() => h.board.list({ harness: 'dsh' }).some(row => row.sessionId === 'S1' && row.online));
    // The count follows the register response and an async beacon write, so it can trail the board going online.
    await until(() => h.beacon()?.auto?.registered === 1);
    assert.deepEqual(h.beacon().auto, { listed: 1, registered: 1, refused: 0, skipped: 0, disposed: 0, failed: {} });
    assert.match((await h.commands.get('ms-register')!.handler({ agent: open, rawInput: '' })).text, /^已登记（无变化）|^已登记 Switchboard/);
    await h.live('S2');
    await until(() => h.board.list({ harness: 'dsh' }).some(row => row.sessionId === 'S2' && row.online));
  } finally { await h.close(); }
});

test('with the real system-prompt registry the reply-mode context is read at every assembly and follows /ms-reply', async () => {
  const h = await host();
  try {
    const open = await h.live('S1');
    await h.load();
    assert.equal(await h.modeLine(), 'Switchboard 回复档位：direct');
    assert.ok((await h.prompt.assemble()).sections.some(section => section.name === 'agent-message-switchboard:daily'));
    const switched = await h.commands.get('ms-reply')!.handler({ agent: open, rawInput: ' confirm' });
    assert.equal(switched.kind, 'success', switched.text);
    for (let index = 0; index < 400 && await h.modeLine() !== 'Switchboard 回复档位：confirm'; index++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(await h.modeLine(), 'Switchboard 回复档位：confirm');
  } finally { await h.close(); }
});
