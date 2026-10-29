// INPUT: Temp HOME/source fixtures driven through runCli with real handlers and a recording launchctl.
// OUTPUT: End-to-end CLI exit codes/output for dry runs, install→uninstall and not-installed paths, and ms ui against a temp HOME.
// POS: Offline CLI integration tests; no real HOME, launchd, Claude or DSH.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rm } from 'node:fs/promises';
import { get } from 'node:http';
import { createHandlers } from '../../src/cli/handlers.ts';
import { runCli, type CliDeps } from '../../src/cli/main.ts';
import { resolvePaths } from '../../src/cli/paths.ts';
import { FAKE_PINS, makeEnv, makeHome, makeSource, recordingLaunchctl, snapshotTree } from './install-fixture.ts';

type UiContext = Readonly<{ open: (url: string) => Promise<void>; untilStopped: () => Promise<void> }>;
const NO_UI: UiContext = { open: async () => {}, untilStopped: () => new Promise(() => {}) };

async function cli(ui: UiContext = NO_UI): Promise<{ run: (argv: string[]) => Promise<[number, string[], string[]]>; home: string; calls: string[][]; cleanup: () => Promise<void> }> {
  const home = await makeHome();
  const source = await makeSource();
  const paths = resolvePaths(home);
  const fake = recordingLaunchctl();
  const handlers = createHandlers({
    env: makeEnv(home, source),
    repin: { paths, now: () => '2026-10-20T00:00:00.000Z', discoverPins: async () => FAKE_PINS, generate: async () => undefined, reload: async () => ({ restartRequired: false }), restart: async () => true },
    launchctl: fake.launchctl, uid: 501, controlTimeoutMs: 500, readyTimeoutMs: 0, sleep: async () => undefined, ui,
  });
  const run = async (argv: string[]): Promise<[number, string[], string[]]> => {
    const out: string[] = [];
    const err: string[] = [];
    const deps: CliDeps = { io: { out: text => out.push(text), err: text => err.push(text) }, cwd: home, paths, controlTimeoutMs: 500, handlers };
    return [await runCli(argv, deps), out, err];
  };
  return { run, home, calls: fake.calls, cleanup: async () => { await rm(home, { recursive: true, force: true }); await rm(source.root, { recursive: true, force: true }); } };
}

test('install --dry-run, uninstall --dry-run and upgrade with nothing installed write nothing and never call launchctl', async () => {
  const { run, home, calls, cleanup } = await cli();
  try {
    const before = await snapshotTree(home);
    const [code, out] = await run(['install', '--dry-run']);
    assert.equal(code, 0);
    assert.match(out[0], /^ms install plan \(dry run, nothing written\):/);
    assert.deepEqual(await run(['uninstall', '--dry-run']), [5, [], ['ms: NOT_INSTALLED']]);
    assert.deepEqual(await run(['repin', '--dry-run']), [5, [], ['ms: NOT_INSTALLED']]);
    assert.deepEqual(await run(['upgrade']), [5, [], ['ms: NOT_INSTALLED: nothing to upgrade; run ms install']]);
    assert.deepEqual(await run(['upgrade', '--dry-run']), [5, [], ['ms: NOT_INSTALLED: nothing to upgrade; run ms install']]);
    assert.deepEqual(await snapshotTree(home), before);
    assert.equal((await run(['install']))[0], 0);
    const installed = await snapshotTree(home);
    assert.deepEqual(await run(['repin']), [0, ['ms repin: pins unchanged (nothing written)'], []]);
    const [dryCode, dryOut] = await run(['uninstall', '--dry-run']);
    assert.equal(dryCode, 0);
    assert.match(dryOut[0], /stop LaunchAgent local\.agent-message-switchboard\.msd if loaded/);
    assert.deepEqual(await snapshotTree(home), installed);
    assert.deepEqual(calls, []);
  } finally { await cleanup(); }
});

test('install, second install, uninstall, daemon start after uninstall: exit codes and messages', async () => {
  const { run, home, calls, cleanup } = await cli();
  try {
    const before = await snapshotTree(home);
    const [code, out] = await run(['install']);
    assert.equal(code, 0);
    assert.match(out[0], /^ms installed: .*\/bundles\/[0-9a-f]{16}\nrecords: \d+\ndsh: installed \(restart DSH once so it loads agent-message-switchboard-dsh\)\nclaude-code: installed \(.*\)\ncodex: skipped \(.*config\.toml not found\); manual install: docs\/user-guide\.md#manual-codex\nnext: ms daemon start$/);
    assert.deepEqual(await run(['install']), [5, [], ['ms: INSTALL_ALREADY_PRESENT']]);
    const [removed, removedOut] = await run(['uninstall']);
    assert.equal(removed, 0);
    assert.match(removedOut[0], /^ms uninstalled\n/);
    assert.deepEqual(calls, [['bootout', 'gui/501/local.agent-message-switchboard.msd'], ['print', 'gui/501/local.agent-message-switchboard.msd']]);
    assert.deepEqual(await snapshotTree(home), before);
    assert.deepEqual(await run(['daemon', 'start']), [5, [], ['ms: NOT_INSTALLED']]);
  } finally { await cleanup(); }
});

function fetchText(url: string, cookie?: string): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    get(url, { headers: cookie === undefined ? {} : { cookie } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
}

test('ms ui serves the page and a down-state snapshot for a HOME without ms, then stops on the signal', async () => {
  let stop!: () => void;
  const opened: string[] = [];
  const { run, cleanup } = await cli({ open: async url => { opened.push(url); },
    untilStopped: () => new Promise<void>(resolve => { stop = resolve; }) });
  try {
    const running = run(['ui']);
    while (opened.length === 0) await new Promise(resolve => setImmediate(resolve));
    const launch = await fetchText(opened[0]);
    assert.equal(launch.status, 303);
    const cookie = String((launch.headers['set-cookie'] as string[])[0]).split(';')[0];
    const base = new URL('/ms-ui/', opened[0]).href;
    const page = await fetchText(base, cookie);
    assert.deepEqual([page.status, page.body.includes('<script type="module" src="main.js"></script>')], [200, true]);
    const state = await fetchText(`${base}api/state`, cookie);
    assert.deepEqual(JSON.parse(state.body), { installed: { 'claude-code': false, dsh: false, codex: false }, daemon: { state: 'down' } });
    stop();
    const [code, out, err] = await running;
    assert.deepEqual([code, out.slice(1), err], [0, ['Press Ctrl+C to stop.', 'ms ui stopped'], []]);
    assert.equal(out[0], `ms ui: ${opened[0]}`);
  } finally { await cleanup(); }
});
