// INPUT: Temporary private run directories, a real Unix control socket and synthetic adapter/Claude sessions.
// OUTPUT: Control API method, error-code, adapter channel, auto policy, reply mode, act preset, letter verification, letter-turn
//         settlement and receipt events, attached-adapter counts in status, deliver correlation and config
//         persistence regressions.
// POS: Offline msd control tests; no Harness host, kernel identity or model proof.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import net from 'node:net';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSwitchboard } from '../../src/daemon/switchboard.ts';
import { AdapterChannel } from '../../src/daemon/adapter-channel.ts';
import { listenControl } from '../../src/daemon/control-server.ts';
import { createConfigStore, createControlMethods } from '../../src/daemon/control-methods.ts';
import { connectControl, type ControlClient } from '../../src/daemon/control-client.ts';
import { writeDaemonConfig, type DaemonConfig } from '../../src/daemon/config.ts';
import { encodeIpcFrame, createIpcDecoder } from '../../src/bridge/ipc-frame.ts';
import { inboundText, REPLY_TOOLS } from '../../src/protocol/inbound-header.ts';
import { type Envelope } from '../../src/protocol/message.ts';

const pin = (name: string, digit: string) => ({ path: `/opt/${name}`, sha256: digit.repeat(64) });
const baseConfig: DaemonConfig = Object.freeze({ schemaVersion: 4, python: pin('python', 'a'),
  claude: { wrapperPins: [pin('sh', 'c')] },
  autoRegister: { 'claude-code': false, dsh: false, codex: false }, autoRegisterProjects: [],
  replyMode: { 'claude-code': 'direct', dsh: 'direct', codex: 'direct' } as const,
  actPreset: { 'claude-code': 'workspace-write', dsh: 'workspace-write', codex: 'workspace-write' } as const,
  linkBudget: { windowSeconds: 600, maxPushes: 30 } });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function daemon(options: { deliveryTimeoutMs?: number; config?: Partial<DaemonConfig> } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'msd-'));
  const run = join(root, 'run'); await mkdir(run, { mode: 0o700 });
  const configPath = join(root, 'config.json');
  const initial = { ...baseConfig, ...options.config };
  await writeDaemonConfig(configPath, initial);
  const board = createSwitchboard();
  const config = createConfigStore(configPath, initial, next => board.setBudget(next.linkBudget));
  const unregistered: string[] = [];
  const dispatch = createControlMethods({ board, config, version: '0.1.0-test', startedAt: '2026-10-20T00:00:00.000Z',
    projectOf: async cwd => cwd === null ? null : cwd.replace(/\/sub$/, ''),
    owners: { 'claude-code': sid => { unregistered.push(sid); return board.unregister({ harness: 'claude-code', sessionId: sid }); } },
    deliveryTimeoutMs: options.deliveryTimeoutMs });
  const socket = join(run, 'msd.sock');
  const server = await listenControl(socket, dispatch);
  const clients: ControlClient[] = [];
  const client = async () => { const value = await connectControl(socket); clients.push(value); return value; };
  const close = async () => { for (const value of clients) value.close(); await server.close(); };
  return { board, socket, configPath, client, close, unregistered };
}

function claudeSession(board: ReturnType<typeof createSwitchboard>, sessionId: string, inbox: Envelope[] = []) {
  const online = board.register({ harness: 'claude-code', sessionId, clientSurface: 'cli', title: '写代码', cwd: '/repo', project: '/repo',
    push: async frame => { inbox.push(frame); return { state: 'delivery-unknown', transport: 'written' } as const; },
    verify: async () => {}, notice: async () => {} });
  return { inbox, sender: Object.freeze({ harness: 'claude-code' as const, sessionId, generation: online.generation }) };
}

async function attach(msd: Awaited<ReturnType<typeof daemon>>, sessionId: string, cwd = '/repo/sub') {
  const dsh = await msd.client();
  await dsh.request('adapter.attach', { harness: 'dsh', instanceId: `desk-${sessionId}` });
  await dsh.request('register', { sessionId, title: '评审', cwd });
  return dsh;
}

test('socket is 0600 inside the private run directory and a second daemon is refused', async () => {
  const msd = await daemon();
  try {
    assert.equal((await stat(msd.socket)).mode & 0o777, 0o600);
    await assert.rejects(listenControl(msd.socket, async () => ({})), /MSD_ALREADY_RUNNING/);
  } finally { await msd.close(); }
});

test('status, sessions, projects, alias, links, messages and config read back daemon state', async () => {
  const msd = await daemon();
  try {
    const cli = await msd.client(); const claude = claudeSession(msd.board, 'C1');
    const dsh = await msd.client();
    assert.deepEqual(await dsh.request('adapter.attach', { harness: 'dsh', instanceId: 'desk-1' }),
      { attached: true, harness: 'dsh', autoRegister: false, autoRegisterProjects: [], replyMode: 'direct', actPreset: 'workspace-write' });
    assert.deepEqual(await dsh.request('register', { sessionId: 'D1', title: '评审', cwd: '/repo/sub' }),
      { harness: 'dsh', sessionId: 'D1', registered: true, project: '/repo' });
    const result = await dsh.request('send', { sessionId: 'D1', harness: 'claude-code', target: '写代码', body: 'hi' }) as
      { sent: boolean; receipt: { linkId: string; transport: string; targetSessionId: string } };
    assert.deepEqual([result.sent, result.receipt.transport, result.receipt.targetSessionId], [true, 'written', 'C1']);
    assert.equal(claude.inbox[0].body, 'hi');
    assert.deepEqual(await cli.request('status'), { version: '0.1.0-test', startedAt: '2026-10-20T00:00:00.000Z',
      sessions: { 'claude-code': { online: 1, offline: 0 }, dsh: { online: 1, offline: 0 }, codex: { online: 0, offline: 0 } },
      links: { total: 1, suspended: 0, paused: 0 }, autoRegister: baseConfig.autoRegister, autoRegisterProjects: [],
      replyMode: baseConfig.replyMode, actPreset: baseConfig.actPreset, adapters: { dsh: 1, codex: 0 } });
    const rows = await cli.request('sessions.list', { harness: 'dsh', project: '/repo' }) as Array<Record<string, unknown>>;
    assert.deepEqual(rows.map(row => [row.sessionId, row.clientSurface, row.title, row.cwd, row.project, row.online]),
      [['D1', 'desktop', '评审', '/repo/sub', '/repo', true]]);
    assert.deepEqual(await cli.request('projects.list'), [{ project: '/repo', sessions: { 'claude-code': { online: 1, offline: 0 },
      dsh: { online: 1, offline: 0 }, codex: { online: 0, offline: 0 } } }]);
    assert.equal((await cli.request('sessions.alias', { harness: 'dsh', sessionId: 'D1', alias: 'reviewer' }) as { alias: string }).alias,
      'reviewer');
    await assert.rejects(cli.request('sessions.alias', { harness: 'claude-code', sessionId: 'C1', alias: 'x', extra: 1 }), /INVALID_REQUEST/);
    const links = await cli.request('links.list') as Array<{ linkId: string; suspended: boolean }>;
    assert.deepEqual([links.length, links[0].linkId, links[0].suspended], [1, result.receipt.linkId, false]);
    const messages = await cli.request('messages.list', { linkId: result.receipt.linkId, limit: 10 }) as Array<Record<string, unknown>>;
    assert.deepEqual([messages.length, messages[0].body, messages[0].bytes], [1, undefined, 2]);
    assert.deepEqual(await cli.request('config.get'), { autoRegister: baseConfig.autoRegister, autoRegisterProjects: [],
      replyMode: baseConfig.replyMode, actPreset: baseConfig.actPreset, linkBudget: baseConfig.linkBudget });
    await dsh.request('unregister', { sessionId: 'D1' });
    assert.equal((await cli.request('status') as { links: { suspended: number } }).links.suspended, 1);
  } finally { await msd.close(); }
});

test('status counts the attached DSH and Codex adapter channels and drops a channel once its connection closes', async () => {
  const msd = await daemon();
  const adapters = async (cli: ControlClient) => (await cli.request('status') as { adapters: unknown }).adapters;
  try {
    const cli = await msd.client();
    assert.deepEqual(await adapters(cli), { dsh: 0, codex: 0 });
    const [dsh1, dsh2, codex] = [await msd.client(), await msd.client(), await msd.client()];
    await dsh1.request('adapter.attach', { harness: 'dsh', instanceId: 'desk-1' });
    await dsh2.request('adapter.attach', { harness: 'dsh', instanceId: 'desk-2' });
    await codex.request('adapter.attach', { harness: 'codex', instanceId: 'codex:1' });
    await assert.rejects(cli.request('adapter.attach', { harness: 'claude-code', instanceId: 'c' }), /INVALID_HARNESS/);
    assert.deepEqual(await adapters(cli), { dsh: 2, codex: 1 });
    dsh2.close(); codex.close();
    for (let tries = 0; tries < 100 && JSON.stringify(await adapters(cli)) !== JSON.stringify({ dsh: 1, codex: 0 }); tries += 1) await sleep(10);
    assert.deepEqual(await adapters(cli), { dsh: 1, codex: 0 });
  } finally { await msd.close(); }
});

test('config.set persists, applies the budget and notifies only the affected adapter harness', async () => {
  const msd = await daemon();
  try {
    const cli = await msd.client(); const dsh = await msd.client(); const codex = await msd.client();
    await dsh.request('adapter.attach', { harness: 'dsh', instanceId: 'desk' });
    await codex.request('adapter.attach', { harness: 'codex', instanceId: 'cx' });
    const dshEvents: unknown[] = []; const codexEvents: unknown[] = [];
    dsh.onEvent((event, data) => dshEvents.push([event, data]));
    codex.onEvent((event, data) => codexEvents.push([event, data]));
    const view = await cli.request('config.set', { autoRegister: { dsh: true }, autoRegisterProjects: { add: ['/repo', '/other'] },
      linkBudget: { windowSeconds: 60, maxPushes: 2 } });
    assert.deepEqual((await cli.request('config.set', { autoRegisterProjects: { remove: ['/other'] } }) as
      { autoRegisterProjects: string[] }).autoRegisterProjects, ['/repo']);
    assert.deepEqual(view, { autoRegister: { 'claude-code': false, dsh: true, codex: false }, autoRegisterProjects: ['/repo', '/other'],
      replyMode: baseConfig.replyMode, actPreset: baseConfig.actPreset, linkBudget: { windowSeconds: 60, maxPushes: 2 } });
    assert.deepEqual(msd.board.budget(), { windowSeconds: 60, maxPushes: 2 });
    const saved = JSON.parse(await readFile(msd.configPath, 'utf8'));
    assert.deepEqual(saved.autoRegister, { claude: false, dsh: true, codex: false });
    assert.deepEqual([saved.autoRegister.dsh, saved.autoRegisterProjects, saved.claude], [true, ['/repo'], baseConfig.claude]);
    assert.equal((await stat(msd.configPath)).mode & 0o777, 0o600);
    await cli.request('status');
    assert.deepEqual(dshEvents, [['config', { autoRegister: true, autoRegisterProjects: ['/repo', '/other'], replyMode: 'direct', actPreset: 'workspace-write' }],
      ['config', { autoRegister: true, autoRegisterProjects: ['/repo'], replyMode: 'direct', actPreset: 'workspace-write' }]]);
    assert.deepEqual(codexEvents, [['config', { autoRegister: false, autoRegisterProjects: ['/repo', '/other'], replyMode: 'direct', actPreset: 'workspace-write' }],
      ['config', { autoRegister: false, autoRegisterProjects: ['/repo'], replyMode: 'direct', actPreset: 'workspace-write' }]]);
    for (const bad of [{ autoRegister: { web: true } }, { linkBudget: { windowSeconds: -1, maxPushes: 2 } }, {},
      { autoRegisterProjects: { add: ['relative'] } }, { autoRegisterProjects: ['/a'] }, { autoRegisterProjects: {} },
      { autoRegisterProjects: { add: ['/a', '/a'] } }]) {
      await assert.rejects(cli.request('config.set', bad), /INVALID_CONFIG/);
    }
  } finally { await msd.close(); }
});

test('adapter autoRegister reads and switches only the attached harness flag through the config.set path', async () => {
  const msd = await daemon({ config: { autoRegisterProjects: ['/repo'] } });
  try {
    const cli = await msd.client(); const dsh = await msd.client(); const codex = await msd.client();
    await dsh.request('adapter.attach', { harness: 'dsh', instanceId: 'desk' });
    await codex.request('adapter.attach', { harness: 'codex', instanceId: 'cx' });
    const dshEvents: unknown[] = []; const codexEvents: unknown[] = [];
    dsh.onEvent((event, data) => dshEvents.push([event, data]));
    codex.onEvent((event, data) => codexEvents.push([event, data]));
    assert.deepEqual(await dsh.request('autoRegister', {}), { autoRegister: false, autoRegisterProjects: ['/repo'] });
    assert.deepEqual(await dsh.request('autoRegister', { enabled: true }), { autoRegister: true, autoRegisterProjects: ['/repo'] });
    assert.deepEqual(await codex.request('autoRegister', {}), { autoRegister: false, autoRegisterProjects: ['/repo'] });
    assert.deepEqual(dshEvents, [['config', { autoRegister: true, autoRegisterProjects: ['/repo'], replyMode: 'direct', actPreset: 'workspace-write' }]]);
    assert.deepEqual(codexEvents, []);
    const saved = JSON.parse(await readFile(msd.configPath, 'utf8'));
    assert.deepEqual([saved.autoRegister, saved.autoRegisterProjects, saved.linkBudget],
      [{ claude: false, dsh: true, codex: false }, ['/repo'], baseConfig.linkBudget]);
    for (const bad of [{ enabled: 'on' }, { enabled: null }, { harness: 'codex', enabled: false }, { enabled: false, autoRegisterProjects: { add: ['/x'] } },
      { autoRegister: { codex: true } }]) {
      await assert.rejects(dsh.request('autoRegister', bad), /INVALID_REQUEST/);
    }
    assert.deepEqual((await cli.request('config.get') as { autoRegister: unknown }).autoRegister, { 'claude-code': false, dsh: true, codex: false });
    await assert.rejects(cli.request('autoRegister', { enabled: false }), /UNKNOWN_METHOD/);
    assert.deepEqual(await codex.request('autoRegister', { enabled: true }), { autoRegister: true, autoRegisterProjects: ['/repo'] });
    assert.deepEqual(await dsh.request('autoRegister', { enabled: false }), { autoRegister: false, autoRegisterProjects: ['/repo'] });
    assert.deepEqual((await cli.request('config.get') as { autoRegister: unknown }).autoRegister, { 'claude-code': false, dsh: false, codex: true });
    assert.deepEqual(dshEvents.length, 2);
  } finally { await msd.close(); }
});

test('auto-mode adapter registration obeys the harness flag and the project allowlist; manual does not', async () => {
  const msd = await daemon({ config: { autoRegister: { 'claude-code': false, dsh: true, codex: false }, autoRegisterProjects: ['/repo'] } });
  try {
    const dsh = await msd.client();
    await dsh.request('adapter.attach', { harness: 'dsh', instanceId: 'desk' });
    assert.deepEqual(await dsh.request('register', { sessionId: 'A1', cwd: '/repo/sub', mode: 'auto' }),
      { harness: 'dsh', sessionId: 'A1', registered: true, project: '/repo' });
    assert.deepEqual(await dsh.request('register', { sessionId: 'A2', cwd: '/elsewhere', mode: 'auto' }),
      { harness: 'dsh', sessionId: 'A2', registered: false, project: '/elsewhere' });
    assert.equal((await dsh.request('register', { sessionId: 'A3', cwd: '/elsewhere', mode: 'manual' }) as { registered: boolean }).registered, true);
    const codex = await msd.client();
    await codex.request('adapter.attach', { harness: 'codex', instanceId: 'cx' });
    assert.equal((await codex.request('register', { sessionId: 'X1', cwd: '/repo', mode: 'auto' }) as { registered: boolean }).registered, false);
    await assert.rejects(dsh.request('register', { sessionId: 'A4', mode: 'sometimes' }), /INVALID_REQUEST/);
    assert.deepEqual(msd.board.list({ harness: 'dsh' }).map(row => row.sessionId), ['A1', 'A3']);
  } finally { await msd.close(); }
});

test('fixed error codes for unknown methods, bad params, offline targets and adapter misuse', async () => {
  const msd = await daemon();
  try {
    const cli = await msd.client();
    await assert.rejects(cli.request('nope'), /UNKNOWN_METHOD/);
    await assert.rejects(cli.request('status', { extra: 1 }), /INVALID_REQUEST/);
    await assert.rejects(cli.request('sessions.list', { harness: 'web' }), /INVALID_HARNESS/);
    await assert.rejects(cli.request('messages.list', { limit: 500 }), /INVALID_REQUEST/);
    await assert.rejects(cli.request('links.resume', { linkId: 'missing' }), /UNKNOWN_LINK/);
    await assert.rejects(cli.request('sessions.alias', { harness: 'dsh', sessionId: 'none', alias: 'a' }), /UNKNOWN_SESSION/);
    await assert.rejects(cli.request('adapter.attach', { harness: 'claude-code', instanceId: 'x' }), /INVALID_HARNESS/);
    const dsh = await attach(msd, 'D1');
    await assert.rejects(dsh.request('adapter.attach', { harness: 'dsh', instanceId: 'x' }), /ALREADY_ATTACHED/);
    await assert.rejects(dsh.request('send', { sessionId: 'D1', harness: 'codex', target: 'C1', body: 'x', messageId: 'bad id' }),
      /INVALID_REQUEST/);
    await assert.rejects(dsh.request('reply', { sessionId: 'D1', inReplyTo: 'a"b', body: 'x' }), /INVALID_REQUEST/);
    await assert.rejects(dsh.request('status'), /UNKNOWN_METHOD/);
    assert.deepEqual(await dsh.request('send', { sessionId: 'D9', harness: 'codex', target: 'C1', body: 'x', title: '新会话', cwd: '/repo/sub' }),
      { sent: false, reason: 'UNKNOWN_TARGET', candidates: [] });
    assert.deepEqual(msd.board.list({ harness: 'dsh' }).map(row => [row.sessionId, row.title, row.project]),
      [['D1', '评审', '/repo'], ['D9', '新会话', '/repo']]);
    await assert.rejects(dsh.request('list', { harness: 'dsh' }), /USE_NATIVE_TOOLS/);
    await assert.rejects(dsh.request('deliver.result', { messageId: 'zz', state: 'dispatched', transport: null }), /UNKNOWN_DELIVERY/);
    const claude = claudeSession(msd.board, 'C1');
    msd.board.unregister({ harness: 'claude-code', sessionId: 'C1' }, claude.sender.generation);
    await assert.rejects(dsh.request('send', { sessionId: 'D1', harness: 'claude-code', target: 'C1', body: 'x' }), /TARGET_OFFLINE/);
    const missing = await dsh.request('send', { sessionId: 'D1', harness: 'codex', target: 'nobody', body: 'x' });
    assert.deepEqual(missing, { sent: false, reason: 'UNKNOWN_TARGET', candidates: [] });
  } finally { await msd.close(); }
});

test('malformed frames get a null-id error then the connection closes', async () => {
  const msd = await daemon();
  try {
    const socket = net.createConnection(msd.socket);
    await new Promise(resolve => socket.once('connect', resolve));
    const decoder = createIpcDecoder(); const received: unknown[] = [];
    socket.on('data', chunk => received.push(...decoder.push(chunk)));
    socket.write(encodeIpcFrame({ schemaVersion: 2, method: 'status' }));
    await new Promise(resolve => socket.once('close', resolve));
    assert.deepEqual(received, [{ schemaVersion: 1, id: null, ok: false, error: 'INVALID_REQUEST' }]);
  } finally { await msd.close(); }
});

test('Claude to DSH delivery waits for the correlated deliver.result from the owning adapter only', async () => {
  const msd = await daemon();
  try {
    const dsh = await attach(msd, 'D1'); const other = await attach(msd, 'D2');
    const otherEvents: unknown[] = []; other.onEvent(event => otherEvents.push(event));
    const hints: unknown[] = [];
    dsh.onEvent((event, data) => {
      const envelope = (data as { envelope: Envelope }).envelope;
      assert.equal(event, 'deliver'); assert.equal(envelope.recipient.nativeSessionId, 'D1');
      assert.deepEqual(Object.keys(data as object), ['envelope', 'replyHint', 'senderLabel']);
      assert.equal((data as { senderLabel: unknown }).senderLabel, '写代码');
      hints.push((data as { replyHint: unknown }).replyHint);
      void dsh.request('deliver.result', { messageId: envelope.messageId, state: 'dispatched', transport: null });
    });
    const claude = claudeSession(msd.board, 'C1');
    const result = await msd.board.send(claude.sender, { harness: 'dsh', target: 'D1', messageId: 'c1', body: '你好' });
    assert.deepEqual(result.sent && [result.receipt.state, result.receipt.transport], ['dispatched', null]);
    assert.deepEqual(otherEvents, []);
    await msd.board.send(claude.sender, { harness: 'dsh', target: 'D1', messageId: 'c0', body: '再见' });
    assert.deepEqual(hints, [true, false]);
    await assert.rejects(dsh.request('deliver.result', { messageId: 'c1', state: 'dispatched', transport: null }), /UNKNOWN_DELIVERY/);
    const replied = await dsh.request('reply', { sessionId: 'D1', inReplyTo: 'c1', body: '收到' }) as { receipt: { sequence: number } };
    assert.equal(replied.receipt.sequence, 1); assert.equal(claude.inbox[0].inReplyTo, 'c1');
  } finally { await msd.close(); }
});

test('missing or invalid deliver.result leaves delivery unknown; closing the adapter takes its sessions offline', async () => {
  const msd = await daemon({ deliveryTimeoutMs: 50 });
  try {
    const dsh = await attach(msd, 'D1');
    dsh.onEvent((_event, data) => {
      const { messageId } = (data as { envelope: Envelope }).envelope;
      if (messageId === 'bad') void dsh.request('deliver.result', { messageId, state: 'dispatched', transport: 'written' }).catch(() => {});
    });
    const claude = claudeSession(msd.board, 'C1');
    for (const messageId of ['quiet', 'bad']) {
      const result = await msd.board.send(claude.sender, { harness: 'dsh', target: 'D1', messageId, body: 'x' });
      assert.deepEqual(result.sent && [result.receipt.state, result.receipt.transport], ['delivery-unknown', null]);
    }
    dsh.close(); await dsh.whenClosed;
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(msd.board.list({ harness: 'dsh' }).map(row => row.online), [false]);
  } finally { await msd.close(); }
});

test('sessions.unregister routes Claude to its owner and other harnesses to the switchboard', async () => {
  const msd = await daemon();
  try {
    const cli = await msd.client(); claudeSession(msd.board, 'C1');
    const dsh = await attach(msd, 'D1');
    assert.deepEqual(await cli.request('sessions.unregister', { harness: 'claude-code', sessionId: 'C1' }), { unregistered: true });
    assert.deepEqual(msd.unregistered, ['C1']);
    assert.deepEqual(await cli.request('sessions.unregister', { harness: 'dsh', sessionId: 'D1' }), { unregistered: true });
    assert.deepEqual(await cli.request('sessions.unregister', { harness: 'dsh', sessionId: 'D1' }), { unregistered: false });
    await assert.rejects(dsh.request('send', { sessionId: 'D1', harness: 'claude-code', target: 'C1', body: 'b' }), /TARGET_OFFLINE/);
    assert.equal(msd.board.list({ harness: 'dsh' })[0].online, true);
    assert.equal((await dsh.request('register', { sessionId: 'D1' }) as { registered: boolean }).registered, true);
    assert.deepEqual(await dsh.request('unregister', { sessionId: 'D1' }), { unregistered: true });
  } finally { await msd.close(); }
});

test('deliver.result with error TARGET_OFFLINE refuses the sender, records undelivered and keeps the target online', async () => {
  const msd = await daemon();
  try {
    const dsh = await attach(msd, 'D1');
    let offline = true;
    dsh.onEvent((_event, data) => {
      const { messageId } = (data as { envelope: Envelope }).envelope;
      void dsh.request('deliver.result', offline ? { messageId, state: 'delivery-unknown', transport: null, error: 'TARGET_OFFLINE' }
        : { messageId, state: 'dispatched', transport: null });
    });
    const claude = claudeSession(msd.board, 'C1');
    await assert.rejects(msd.board.send(claude.sender, { harness: 'dsh', target: 'D1', messageId: 'z1', body: 'x' }), /TARGET_OFFLINE/);
    assert.deepEqual(msd.board.messages({}).map(row => row.state), ['undelivered']);
    assert.equal(msd.board.list({ harness: 'dsh' })[0].online, true);
    offline = false;
    const again = await msd.board.send(claude.sender, { harness: 'dsh', target: 'D1', messageId: 'z1', body: 'x' });
    assert.equal(again.sent && again.receipt.state, 'dispatched');
    const bad = await msd.client();
    await bad.request('adapter.attach', { harness: 'dsh', instanceId: 'x' });
    await bad.request('register', { sessionId: 'D2' });
    bad.onEvent((_event, data) => {
      const { messageId } = (data as { envelope: Envelope }).envelope;
      void bad.request('deliver.result', { messageId, state: 'dispatched', transport: null, error: 'TARGET_OFFLINE' }).catch(() => {});
      void bad.request('deliver.result', { messageId, state: 'delivery-unknown', transport: null, error: 'OTHER' }).catch(() => {});
    });
    const quiet = msd.board.send(claude.sender, { harness: 'dsh', target: 'D2', body: 'y' });
    await sleep(20);
    await bad.request('deliver.result', { messageId: (msd.board.messages({ limit: 1 })[0]).messageId, state: 'dispatched', transport: null });
    assert.equal((await quiet).sent, true);
  } finally { await msd.close(); }
});

test('config.reload re-reads the file, applies it, notifies adapters and flags a needed restart for python changes', async () => {
  const msd = await daemon();
  try {
    const cli = await msd.client(); const dsh = await attach(msd, 'D1');
    const events: unknown[] = []; dsh.onEvent((event, data) => events.push([event, data]));
    await writeDaemonConfig(msd.configPath, { ...baseConfig, autoRegister: { 'claude-code': false, dsh: true, codex: false },
      linkBudget: { windowSeconds: 30, maxPushes: 5 } });
    assert.deepEqual(await cli.request('config.reload'), { autoRegister: { 'claude-code': false, dsh: true, codex: false },
      autoRegisterProjects: [], replyMode: baseConfig.replyMode, actPreset: baseConfig.actPreset, linkBudget: { windowSeconds: 30, maxPushes: 5 },
      restartRequired: false });
    assert.deepEqual(msd.board.budget(), { windowSeconds: 30, maxPushes: 5 });
    await sleep(10);
    assert.deepEqual(events, [['config', { autoRegister: true, autoRegisterProjects: [], replyMode: 'direct', actPreset: 'workspace-write' }]]);
    await writeDaemonConfig(msd.configPath, { ...baseConfig, python: pin('python-new', 'f') });
    assert.equal((await cli.request('config.reload') as { restartRequired: boolean }).restartRequired, true);
    await writeFile(msd.configPath, '{"schemaVersion":1}', { mode: 0o600 });
    await assert.rejects(cli.request('config.reload'), /INVALID_CONFIG/);
    await writeDaemonConfig(msd.configPath, baseConfig);
    const file = JSON.parse(await readFile(msd.configPath, 'utf8'));
    assert.deepEqual([file.schemaVersion, file.claude], [4, { wrapperPins: [pin('sh', 'c')] }]);
    const claudePins = { cliPins: [pin('claude', 'b')], appCliPins: [], appPin: null, appHelperPins: [] };
    for (const bad of [{ ...file, schemaVersion: 1 }, { ...file, schemaVersion: 2 }, { ...file, schemaVersion: 3 }, { ...file, schemaVersion: 1, claude: { ...claudePins, wrapperPins: [] } },
      { ...file, claude: { ...file.claude, cliPins: [] } }, { ...file, claude: { wrapperPins: [pin('sh', 'c'), pin('sh', 'd')] } },
      { ...file, claude: { wrapperPins: [pin('sh', 'c'), pin('bash', 'c')] } }, { ...file, claude: {} }]) {
      await writeFile(msd.configPath, JSON.stringify(bad), { mode: 0o600 });
      await assert.rejects(cli.request('config.reload'), /INVALID_CONFIG/);
    }
    assert.deepEqual((await cli.request('config.get') as { linkBudget: unknown }).linkBudget, baseConfig.linkBudget);
    await assert.rejects(cli.request('config.reload', { extra: 1 }), /INVALID_REQUEST/);
  } finally { await msd.close(); }
});

test('the control API names harnesses only by protocol id; config.json keeps its autoRegister.claude key', async () => {
  const msd = await daemon();
  try {
    const cli = await msd.client();
    const view = await cli.request('config.set', { autoRegister: { 'claude-code': true } }) as { autoRegister: Record<string, boolean> };
    assert.deepEqual(view.autoRegister, { 'claude-code': true, dsh: false, codex: false });
    assert.deepEqual(JSON.parse(await readFile(msd.configPath, 'utf8')).autoRegister, { claude: true, dsh: false, codex: false });
    assert.deepEqual((await cli.request('status') as { autoRegister: unknown }).autoRegister, { 'claude-code': true, dsh: false, codex: false });
    assert.deepEqual((await cli.request('config.reload') as { autoRegister: unknown }).autoRegister, { 'claude-code': true, dsh: false, codex: false });
    await assert.rejects(cli.request('config.set', { autoRegister: { claude: false } }), /INVALID_CONFIG/);
    for (const [method, params] of [['sessions.list', { harness: 'claude' }], ['sessions.unregister', { harness: 'claude', sessionId: 'C1' }],
      ['sessions.alias', { harness: 'claude', sessionId: 'C1', alias: 'a' }], ['adapter.attach', { harness: 'claude', instanceId: 'x' }]] as const) {
      await assert.rejects(cli.request(method, params), /INVALID_HARNESS/);
    }
    const status = await cli.request('status') as { sessions: Record<string, unknown> };
    assert.deepEqual(Object.keys(status.sessions), ['claude-code', 'dsh', 'codex']);
  } finally { await msd.close(); }
});

test('the replyMode request reads and sets only this harness, and config.set replyMode notifies only that harness', async () => {
  const msd = await daemon();
  try {
    const cli = await msd.client(); const dsh = await msd.client(); const codex = await msd.client();
    await dsh.request('adapter.attach', { harness: 'dsh', instanceId: 'desk' });
    await codex.request('adapter.attach', { harness: 'codex', instanceId: 'cx' });
    const dshEvents: unknown[] = []; const codexEvents: unknown[] = [];
    dsh.onEvent((event, data) => dshEvents.push([event, data])); codex.onEvent((event, data) => codexEvents.push([event, data]));
    assert.deepEqual(await dsh.request('replyMode', {}), { replyMode: 'direct' });
    assert.deepEqual(await dsh.request('replyMode', { mode: 'confirm' }), { replyMode: 'confirm' });
    assert.deepEqual(await codex.request('replyMode', {}), { replyMode: 'direct' });
    for (const bad of [{ mode: 'maybe' }, { mode: 'status' }, { mode: 'confirm', harness: 'codex' }, { enabled: true }]) {
      await assert.rejects(dsh.request('replyMode', bad), /INVALID_REQUEST/);
    }
    await cli.request('config.set', { replyMode: { codex: 'confirm' } });
    await sleep(10);
    assert.deepEqual(dshEvents, [['config', { autoRegister: false, autoRegisterProjects: [], replyMode: 'confirm', actPreset: 'workspace-write' }]]);
    assert.deepEqual(codexEvents, [['config', { autoRegister: false, autoRegisterProjects: [], replyMode: 'confirm', actPreset: 'workspace-write' }]]);
    assert.deepEqual((await cli.request('status') as { replyMode: unknown }).replyMode,
      { 'claude-code': 'direct', dsh: 'confirm', codex: 'confirm' });
    assert.deepEqual(JSON.parse(await readFile(msd.configPath, 'utf8')).replyMode, { claude: 'direct', dsh: 'confirm', codex: 'confirm' });
    const fresh = await msd.client();
    assert.deepEqual(await fresh.request('adapter.attach', { harness: 'dsh', instanceId: 'desk-2' }),
      { attached: true, harness: 'dsh', autoRegister: false, autoRegisterProjects: [], replyMode: 'confirm', actPreset: 'workspace-write' });
  } finally { await msd.close(); }
});

test('config.set actPreset notifies only that harness, status, config.get and attach carry it, and act is accepted for all three', async () => {
  const msd = await daemon();
  try {
    const cli = await msd.client(); const dsh = await msd.client(); const codex = await msd.client();
    await dsh.request('adapter.attach', { harness: 'dsh', instanceId: 'desk' });
    await codex.request('adapter.attach', { harness: 'codex', instanceId: 'cx' });
    const dshEvents: unknown[] = []; const codexEvents: unknown[] = [];
    dsh.onEvent((event, data) => dshEvents.push([event, data])); codex.onEvent((event, data) => codexEvents.push([event, data]));
    const view = await cli.request('config.set', { actPreset: { dsh: 'full-access' } }) as Record<string, unknown>;
    assert.deepEqual(Object.keys(view), ['autoRegister', 'autoRegisterProjects', 'replyMode', 'actPreset', 'linkBudget']);
    assert.deepEqual(view.actPreset, { 'claude-code': 'workspace-write', dsh: 'full-access', codex: 'workspace-write' });
    await sleep(10);
    assert.deepEqual(dshEvents, [['config', { autoRegister: false, autoRegisterProjects: [], replyMode: 'direct', actPreset: 'full-access' }]]);
    assert.deepEqual(codexEvents, []);
    assert.deepEqual((await cli.request('status') as { actPreset: unknown }).actPreset,
      { 'claude-code': 'workspace-write', dsh: 'full-access', codex: 'workspace-write' });
    assert.deepEqual((await cli.request('config.get') as { actPreset: unknown }).actPreset,
      { 'claude-code': 'workspace-write', dsh: 'full-access', codex: 'workspace-write' });
    assert.deepEqual(JSON.parse(await readFile(msd.configPath, 'utf8')).actPreset,
      { claude: 'workspace-write', dsh: 'full-access', codex: 'workspace-write' });
    const fresh = await msd.client();
    assert.deepEqual(await fresh.request('adapter.attach', { harness: 'dsh', instanceId: 'desk-2' }),
      { attached: true, harness: 'dsh', autoRegister: false, autoRegisterProjects: [], replyMode: 'direct', actPreset: 'full-access' });
    for (const bad of [{ actPreset: { claude: 'read-only' } }, { actPreset: { dsh: 'danger-full-access' } }, { actPreset: {} }]) {
      await assert.rejects(cli.request('config.set', bad), /INVALID_CONFIG/, JSON.stringify(bad));
    }
    assert.deepEqual((await cli.request('config.set', { replyMode: { 'claude-code': 'act' } }) as { replyMode: unknown }).replyMode,
      { ...baseConfig.replyMode, 'claude-code': 'act' });
    await cli.request('config.set', { replyMode: { 'claude-code': 'direct' } });
    assert.deepEqual(await dsh.request('replyMode', { mode: 'act' }), { replyMode: 'act' });
    await dsh.request('replyMode', { mode: 'direct' });
    assert.deepEqual(await codex.request('replyMode', { mode: 'act' }), { replyMode: 'act' });
    await codex.request('replyMode', { mode: 'direct' });
    await assert.rejects(dsh.request('actPreset', { preset: 'read-only' }), /UNKNOWN_METHOD/);
    assert.deepEqual((await cli.request('config.get') as { replyMode: unknown }).replyMode, baseConfig.replyMode);
  } finally { await msd.close(); }
});

test('letterMode verifies a letter delivered to a registered session once, refuses others and never registers', async () => {
  const msd = await daemon();
  try {
    const claude = claudeSession(msd.board, 'C1');
    const dsh = await attach(msd, 'D1');
    let delivered: Readonly<{ envelope: Envelope; replyHint: boolean; senderLabel: string | null }> | undefined;
    dsh.onEvent((event, data) => { if (event === 'deliver') delivered = data as typeof delivered; });
    const sending = msd.board.send(claude.sender, { harness: 'dsh', target: 'D1', body: '请看一下' });
    sending.catch(() => {});
    for (let index = 0; index < 200 && delivered === undefined; index++) await sleep(5);
    const prompt = inboundText(delivered!.envelope, { replyTool: REPLY_TOOLS.dsh, replyHint: delivered!.replyHint,
      senderLabel: delivered!.senderLabel });
    assert.deepEqual(await dsh.request('letterMode', { sessionId: 'D1', prompt }), { replyMode: 'direct' });
    await assert.rejects(dsh.request('letterMode', { sessionId: 'D1', prompt }), /LETTER_ALREADY_NOTIFIED/);
    await assert.rejects(dsh.request('letterMode', { sessionId: 'D1', prompt: 'hello' }), /NOT_A_LETTER/);
    await assert.rejects(dsh.request('letterMode', { sessionId: 'D9', prompt }), /LETTER_NOT_VERIFIED/);
    assert.equal(msd.board.list({ harness: 'dsh' }).some(row => row.sessionId === 'D9'), false);
    for (const bad of [{ sessionId: 'D1' }, { sessionId: 'D1', prompt: 1 }, { sessionId: 'D1', prompt, extra: 1 }]) {
      await assert.rejects(dsh.request('letterMode', bad), /INVALID_REQUEST/);
    }
    await dsh.request('deliver.result', { messageId: delivered!.envelope.messageId, state: 'dispatched', transport: null });
    await sending;
  } finally { await msd.close(); }
});

async function codexChannel(msd: Awaited<ReturnType<typeof daemon>>, sessionId: string) {
  const codex = await msd.client();
  await codex.request('adapter.attach', { harness: 'codex', instanceId: `cx-${sessionId}` });
  await codex.request('register', { sessionId, title: '执行', cwd: '/repo' });
  codex.onEvent((event, data) => {
    if (event === 'deliver') void codex.request('deliver.result', { messageId: (data as { envelope: Envelope }).envelope.messageId,
      state: 'dispatched', transport: null });
  });
  return codex;
}

test('letterTurnEnd takes strict params for this channel\'s online sessions; the receipt event reaches only the sender\'s channel', async () => {
  const msd = await daemon();
  try {
    const dsh = await attach(msd, 'D1'); const bystander = await attach(msd, 'D2');
    const codex = await codexChannel(msd, 'X1');
    const receipts: unknown[] = []; const others: string[] = [];
    dsh.onEvent((event, data) => { if (event === 'receipt') receipts.push(data); });
    bystander.onEvent(event => others.push(event)); codex.onEvent(event => { if (event !== 'deliver') others.push(event); });
    await dsh.request('send', { sessionId: 'D1', harness: 'codex', target: 'X1', messageId: 'l1', body: '请跑测试' });
    const end = (params: Record<string, unknown>) => codex.request('letterTurnEnd', params);
    const valid = { sessionId: 'X1', messageIds: ['l1'], reason: 'interrupted' };
    for (const bad of [{ ...valid, extra: 1 }, { ...valid, messageIds: [] }, { ...valid, messageIds: 'l1' },
      { ...valid, messageIds: Array.from({ length: 65 }, (_, index) => `m${index}`) }, { ...valid, messageIds: ['-bad'] },
      { ...valid, reason: 'stopped' }, { sessionId: 'X1', messageIds: ['l1'] }]) {
      await assert.rejects(end(bad), /INVALID_REQUEST/);
    }
    await assert.rejects(end({ ...valid, sessionId: 'X9' }), /LETTER_NOT_VERIFIED/);
    await assert.rejects(end({ ...valid, sessionId: 'D1' }), /LETTER_NOT_VERIFIED/);
    assert.deepEqual(await dsh.request('letterTurnEnd', { ...valid, sessionId: 'D1' }), { outcomes: [{ messageId: 'l1', outcome: 'ignored' }] },
      'the sender\'s own channel cannot settle a letter it sent');
    assert.deepEqual(await end(valid), { outcomes: [{ messageId: 'l1', outcome: 'receipted' }] });
    for (let index = 0; index < 200 && receipts.length === 0; index++) await sleep(5);
    assert.equal(receipts.length, 1);
    const [receipt] = receipts as { receiptId: string; sessionId: string; text: string }[];
    assert.deepEqual(Object.keys(receipt), ['receiptId', 'sessionId', 'text']);
    assert.equal(receipt.sessionId, 'D1'); assert.match(receipt.text, /^Switchboard 回执 · 不是对方的回信 · 原消息 messageId "l1"\n/);
    assert.match(receipt.text, /Codex 会话 "执行"/);
    assert.deepEqual(await end({ ...valid, messageIds: Array.from({ length: 64 }, (_, index) => index ? `m${index}` : 'l1') }).then(value =>
      (value as { outcomes: { outcome: string }[] }).outcomes.slice(0, 2).map(item => item.outcome)), ['duplicate', 'ignored']);
    await sleep(20);
    assert.deepEqual(others, []); assert.equal(receipts.length, 1);
  } finally { await msd.close(); }
});

test('a receipt is not emitted once the sender\'s connection is closed', async () => {
  const board = createSwitchboard();
  let open = true; const emitted: unknown[] = [];
  const connection = Object.freeze({ emit: (event: string, data: unknown) => emitted.push([event, data]), close: () => {},
    isOpen: () => open, whenClosed: new Promise<void>(() => {}) });
  const options = { board, projectOf: async (cwd: string | null) => cwd,
    auto: { enabled: () => false, allows: () => true, projects: () => [], set: async () => {} },
    reply: { mode: () => 'direct' as const, set: async () => {} } };
  const channel = new AdapterChannel(connection, 'dsh', 'desk', options);
  await channel.handle('register', { sessionId: 'D1' });
  const claude = claudeSession(board, 'C1');
  const sender = Object.freeze({ harness: 'dsh' as const, sessionId: 'D1', generation: board.online({ harness: 'dsh', sessionId: 'D1' })!.generation });
  for (const messageId of ['a', 'b']) await board.send(sender, { harness: 'claude-code', target: 'C1', messageId, body: 'x' });
  assert.equal(claude.inbox.length, 2);
  assert.deepEqual(board.letterTurnEnded({ harness: 'claude-code', sessionId: 'C1' }, ['a'], 'ended'), [{ messageId: 'a', outcome: 'receipted' }]);
  await sleep(5);
  assert.deepEqual(emitted.map(item => (item as [string])[0]), ['receipt']);
  open = false;
  assert.deepEqual(board.letterTurnEnded({ harness: 'claude-code', sessionId: 'C1' }, ['b'], 'ended'), [{ messageId: 'b', outcome: 'receipted' }]);
  await sleep(5);
  assert.equal(emitted.length, 1);
});
