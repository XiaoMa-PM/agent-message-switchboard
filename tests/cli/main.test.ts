// INPUT: Synthetic argv, a fake msd socket and recording output sinks.
// OUTPUT: runCli stdout/stderr text and exit-code regressions for control, usage, help and handler routing (ui and upgrade included) paths.
// POS: Offline CLI entry tests; install/daemon handlers are stubs here and tested in their own files.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCli, type CliDeps } from '../../src/cli/main.ts';
import { resolvePaths } from '../../src/cli/paths.ts';
import { startFakeDaemon, okReply, errorReply } from './fake-daemon.ts';

function deps(socket: string, calls: string[] = []): { deps: CliDeps; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const paths = { ...resolvePaths('/tmp/ms-home-unused'), socket };
  return {
    out, err,
    deps: {
      io: { out: text => out.push(text), err: text => err.push(text) },
      cwd: '/work', paths, controlTimeoutMs: 2000,
      handlers: {
        install: async (dryRun, harness) => { calls.push(`install:${dryRun}:${harness}`); return 'installed'; },
        repin: async dryRun => { calls.push(`repin:${dryRun}`); return 'repinned'; },
        uninstall: async (dryRun, keepData, harness) => { calls.push(`uninstall:${dryRun}:${keepData}:${harness}`); return 'removed'; },
        daemon: async action => { calls.push(`daemon:${action}`); return `daemon ${action}`; },
        ui: async out => { calls.push('ui'); out('ms ui: http://127.0.0.1:1/ms-ui/?code=c'); return 'ms ui stopped'; },
        upgrade: async (dryRun, out) => { calls.push(`upgrade:${dryRun}`); out('ms upgrade: 1.0.0 → 1.0.1'); return 'ms upgraded 1.0.0 → 1.0.1'; },
      },
    },
  };
}

test('control command prints the rendered result and exits 0', async () => {
  const daemon = await startFakeDaemon(okReply({ autoRegister: { 'claude-code': true, dsh: false, codex: false }, autoRegisterProjects: [],
    replyMode: { 'claude-code': 'direct', dsh: 'direct', codex: 'direct' }, actPreset: { 'claude-code': 'workspace-write', dsh: 'workspace-write', codex: 'workspace-write' },
    linkBudget: { windowSeconds: 600, maxPushes: 30 } }));
  try {
    const run = deps(daemon.socketPath);
    assert.equal(await runCli(['config', 'set', 'auto-register', 'on', '--harness', 'claude-code'], run.deps), 0);
    assert.deepEqual(run.out, ['auto-register: claude-code on, dsh off, codex off\nauto-register projects: (any)\n'
      + 'reply-mode: claude-code direct, dsh direct, codex direct\n'
      + 'act-preset: claude-code workspace-write, dsh workspace-write, codex workspace-write\nlink-budget: 30 pushes per 600 s']);
    assert.deepEqual(run.err, []);
    assert.deepEqual(daemon.requests.map(request => [request.method, request.params]),
      [['config.set', { autoRegister: { 'claude-code': true } }]]);
  } finally { await daemon.close(); }
});

test('daemon refusal prints the fixed code to stderr with exit 1', async () => {
  const daemon = await startFakeDaemon(errorReply('CONFIG_INVALID'));
  try {
    const run = deps(daemon.socketPath);
    assert.equal(await runCli(['config', 'get'], run.deps), 1);
    assert.deepEqual(run.out, []);
    assert.deepEqual(run.err, ['ms: DAEMON_ERROR: CONFIG_INVALID']);
  } finally { await daemon.close(); }
});

test('unreachable daemon exits 3 with a start hint; protocol violation exits 4', async () => {
  const run = deps('/tmp/ms-cli-absent/msd.sock');
  assert.equal(await runCli(['status'], run.deps), 3);
  assert.deepEqual(run.err, ['ms: DAEMON_UNAVAILABLE (run `ms daemon start`)']);
  const daemon = await startFakeDaemon(okReply({ wrong: true }));
  try {
    const bad = deps(daemon.socketPath);
    assert.equal(await runCli(['status'], bad.deps), 4);
    assert.deepEqual(bad.err, ['ms: DAEMON_PROTOCOL_INVALID']);
  } finally { await daemon.close(); }
});

test('usage errors exit 2 without contacting the daemon; help exits 0', async () => {
  const run = deps('/tmp/ms-cli-absent/msd.sock');
  assert.equal(await runCli(['messages', '--limit', '500'], run.deps), 2);
  assert.deepEqual(run.err, ['ms: USAGE_INVALID (run `ms help`)']);
  const help = deps('/tmp/ms-cli-absent/msd.sock');
  assert.equal(await runCli(['help'], help.deps), 0);
  assert.match(help.out[0], /^usage: ms <command>/);
  for (const name of ['install', 'uninstall', '--keep-data', 'repin', 'daemon start|stop|status', 'sessions', 'projects', 'alias', 'links resume', 'messages', 'config get', 'config set auto-register', '--project', 'config set reply-mode [--harness claude-code|dsh|codex] direct|confirm|act',
    'config set act-preset [--harness claude-code|dsh|codex] read-only|workspace-write|full-access', 'ui  ', 'read-only status page', 'upgrade [--dry-run]', 'npm i -g agent-message-switchboard@latest']) {
    assert.ok(help.out[0].includes(name), name);
  }
});

test('install, uninstall, daemon, ui and upgrade commands route to their handlers', async () => {
  const calls: string[] = [];
  const run = deps('/tmp/ms-cli-absent/msd.sock', calls);
  assert.equal(await runCli(['install', '--dry-run'], run.deps), 0);
  assert.equal(await runCli(['uninstall', '--keep-data'], run.deps), 0);
  assert.equal(await runCli(['daemon', 'status'], run.deps), 0);
  assert.equal(await runCli(['repin', '--dry-run'], run.deps), 0);
  assert.equal(await runCli(['install', '--harness', 'codex'], run.deps), 0);
  assert.equal(await runCli(['uninstall', '--harness', 'dsh', '--dry-run'], run.deps), 0);
  assert.equal(await runCli(['ui'], run.deps), 0);
  assert.equal(await runCli(['upgrade'], run.deps), 0);
  assert.equal(await runCli(['upgrade', '--dry-run'], run.deps), 0);
  assert.deepEqual(calls, ['install:true:null', 'uninstall:false:true:null', 'daemon:status', 'repin:true', 'install:false:codex', 'uninstall:true:false:dsh', 'ui',
    'upgrade:false', 'upgrade:true']);
  assert.deepEqual(run.out, ['installed', 'removed', 'daemon status', 'repinned', 'installed', 'removed', 'ms ui: http://127.0.0.1:1/ms-ui/?code=c', 'ms ui stopped',
    'ms upgrade: 1.0.0 → 1.0.1', 'ms upgraded 1.0.0 → 1.0.1', 'ms upgrade: 1.0.0 → 1.0.1', 'ms upgraded 1.0.0 → 1.0.1']);
});

test('unexpected handler failures exit 70 without echoing internal messages', async () => {
  const run = deps('/tmp/ms-cli-absent/msd.sock');
  const failing = { ...run.deps, handlers: { ...run.deps.handlers, install: async () => { throw new Error('secret /Users/x/path'); } } };
  assert.equal(await runCli(['install'], failing), 70);
  assert.deepEqual(run.err, ['ms: INTERNAL_ERROR']);
});

test('Python pin-mismatch daemon codes point at ms repin', async () => {
  for (const code of ['RUNTIME_PIN_MISMATCH', 'UNSUPPORTED_RUNTIME']) {
    const daemon = await startFakeDaemon(errorReply(code));
    try {
      const run = deps(daemon.socketPath);
      assert.equal(await runCli(['sessions'], run.deps), 1);
      assert.deepEqual(run.err, [`ms: DAEMON_ERROR: ${code} (run \`ms repin\`)`]);
    } finally { await daemon.close(); }
  }
});

test('Claude identity codes are not pin problems and get no repin hint', async () => {
  for (const code of ['INVALID_CLI_ANCESTRY', 'UNKNOWN_CLAUDE_BINARY']) {
    const daemon = await startFakeDaemon(errorReply(code));
    try {
      const run = deps(daemon.socketPath);
      assert.equal(await runCli(['status'], run.deps), 1);
      assert.deepEqual(run.err, [`ms: DAEMON_ERROR: ${code}`]);
    } finally { await daemon.close(); }
  }
});

type Row = { harness: string; sessionId: string; clientSurface: string; title: string | null; cwd: string | null; project: string | null;
  alias: string | null; online: boolean; registeredAt: string; lastSeenAt: string };

function directoryDaemon() {
  const at = '2026-10-21T02:47:49.154Z';
  const row = (harness: string, sessionId: string, clientSurface: string, online: boolean): Row =>
    ({ harness, sessionId, clientSurface, title: `${harness} work`, cwd: '/w', project: '/w', alias: null, online, registeredAt: at, lastSeenAt: at });
  const state = {
    rows: [row('claude-code', 'S-c', 'cli', true), row('dsh', 'S-d', 'desktop', true), row('codex', 'S-x', 'cli', false)],
    autoRegister: { 'claude-code': false, dsh: false, codex: false } as Record<string, boolean>,
    replyMode: { 'claude-code': 'direct', dsh: 'direct', codex: 'direct' } as Record<string, string>,
    actPreset: { 'claude-code': 'workspace-write', dsh: 'workspace-write', codex: 'workspace-write' } as Record<string, string>,
  };
  const counts = (rows: Row[]) => Object.fromEntries(['claude-code', 'dsh', 'codex'].map(name => [name, {
    online: rows.filter(item => item.harness === name && item.online).length, offline: rows.filter(item => item.harness === name && !item.online).length,
  }]));
  const config = () => ({ autoRegister: { ...state.autoRegister }, autoRegisterProjects: [], replyMode: { ...state.replyMode },
    actPreset: { ...state.actPreset }, linkBudget: { windowSeconds: 600, maxPushes: 30 } });
  const handle = (method: string, params: Record<string, any>): unknown => {
    if (method === 'sessions.list') return state.rows.filter(item => params.harness === undefined || item.harness === params.harness);
    if (method === 'sessions.alias') {
      const found = state.rows.find(item => item.harness === params.harness && item.sessionId === params.sessionId)!;
      found.alias = params.alias;
      return found;
    }
    if (method === 'projects.list') return [{ project: '/w', sessions: counts(state.rows) }];
    if (method === 'status') {
      return { version: '0.1.0-daily', startedAt: at, sessions: counts(state.rows), links: { total: 0, suspended: 0, paused: 0 },
        autoRegister: { ...state.autoRegister }, autoRegisterProjects: [], replyMode: { ...state.replyMode }, actPreset: { ...state.actPreset },
        adapters: { dsh: 0, codex: 0 } };
    }
    if (method === 'config.set') {
      Object.assign(state.autoRegister, params.autoRegister); Object.assign(state.replyMode, params.replyMode); Object.assign(state.actPreset, params.actPreset);
      return config();
    }
    if (method === 'config.get') return config();
    throw new Error(`unexpected ${method}`);
  };
  return { state, reply: (request: { id: unknown; method: unknown; params: unknown }) =>
    ({ schemaVersion: 1, id: request.id, ok: true, result: handle(request.method as string, request.params as Record<string, any>) }) };
}

test('a non-empty directory with claude-code, dsh and codex contacts renders through every management command', async () => {
  const directory = directoryDaemon();
  const daemon = await startFakeDaemon(directory.reply);
  try {
    const run = deps(daemon.socketPath);
    const cli = async (argv: string[]) => { run.out.length = 0; run.err.length = 0; const code = await runCli(argv, run.deps); return { code, out: run.out.join('\n'), err: run.err.join('\n') }; };
    let result = await cli(['sessions']);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /^claude-code +cli +S-c +- +claude-code work +\/w +online/m);
    assert.match(result.out, /^dsh +desktop +S-d /m);
    assert.match(result.out, /^codex +cli +S-x .* offline /m);
    result = await cli(['sessions', '--harness', 'claude-code', '--json']);
    assert.deepEqual(JSON.parse(result.out).map((item: Row) => item.sessionId), ['S-c']);
    assert.deepEqual(daemon.requests.at(-1)!.params, { harness: 'claude-code' });
    assert.equal((await cli(['alias', 'claude-code', 'S-c', '文档'])).out, 'alias claude-code:S-c = 文档');
    assert.match((await cli(['sessions', '--harness', 'claude-code'])).out, /^claude-code +cli +S-c +文档 /m);
    assert.equal((await cli(['alias', 'claude-code', 'S-c', '--clear'])).out, 'alias claude-code:S-c cleared');
    directory.state.rows[0].online = false;
    assert.match((await cli(['sessions'])).out, /^claude-code +cli +S-c +- .* offline /m);
    assert.match((await cli(['status'])).out, /^sessions: claude-code 0 online \/ 1 offline, dsh 1 online \/ 0 offline, codex 0 online \/ 1 offline$/m);
    assert.match((await cli(['projects'])).out, /^PROJECT +CLAUDE-CODE ON\/OFF +DSH ON\/OFF +CODEX ON\/OFF\n\/w +0\/1 +1\/0 +0\/1$/);
    assert.equal((await cli(['config', 'set', 'auto-register', '--harness', 'claude-code', 'on'])).code, 0);
    assert.deepEqual(daemon.requests.at(-1)!.params, { autoRegister: { 'claude-code': true } });
    assert.match((await cli(['config', 'get'])).out, /^auto-register: claude-code on, dsh off, codex off$/m);
    assert.equal((await cli(['config', 'set', 'reply-mode', '--harness', 'dsh', 'confirm'])).code, 0);
    assert.deepEqual(daemon.requests.at(-1)!.params, { replyMode: { dsh: 'confirm' } });
    assert.match((await cli(['config', 'get'])).out, /^reply-mode: claude-code direct, dsh confirm, codex direct$/m);
    assert.match((await cli(['status'])).out, /^reply-mode: claude-code direct, dsh confirm, codex direct$/m);
    assert.deepEqual(JSON.parse((await cli(['status', '--json'])).out).replyMode, { 'claude-code': 'direct', dsh: 'confirm', codex: 'direct' });
    assert.equal((await cli(['config', 'set', 'act-preset', '--harness', 'codex', 'full-access'])).code, 0);
    assert.deepEqual(daemon.requests.at(-1)!.params, { actPreset: { codex: 'full-access' } });
    assert.match((await cli(['config', 'get'])).out, /^act-preset: claude-code workspace-write, dsh workspace-write, codex full-access$/m);
    assert.match((await cli(['status'])).out, /^act-preset: claude-code workspace-write, dsh workspace-write, codex full-access$/m);
    assert.equal((await cli(['config', 'set', 'reply-mode', 'confirm'])).code, 0);
    assert.deepEqual(daemon.requests.at(-1)!.params, { replyMode: { 'claude-code': 'confirm', dsh: 'confirm', codex: 'confirm' } });
    assert.deepEqual(JSON.parse((await cli(['config', 'get', '--json'])).out).replyMode, { 'claude-code': 'confirm', dsh: 'confirm', codex: 'confirm' });
  } finally { await daemon.close(); }
});
