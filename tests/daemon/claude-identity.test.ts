// INPUT: Synthetic signed process chains (Developer ID signer or sha256 per process) and kernel peers.
// OUTPUT: Signature-based Claude CLI identification, desktop/standalone/agent-view surface, wrapper pins and fail-closed ancestry regressions.
// POS: Offline daily Claude identity tests; the real Security.framework lookup is covered in tests/policy.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ANTHROPIC_TEAM_ID, CLAUDE_IDENTIFIERS, resolveClaudeIdentity } from '../../src/daemon/claude-identity.ts';
import { type CodeSigner, type SignedSnapshot } from '../../src/adapters/claude/peer-identity.ts';

const uid = 501;
const signer = (identifier: string, teamId = ANTHROPIC_TEAM_ID, runtime = true): CodeSigner => Object.freeze({ teamId, identifier, runtime });
const CLI = signer(CLAUDE_IDENTIFIERS.cli); const APP = signer(CLAUDE_IDENTIFIERS.app); const HELPER = signer(CLAUDE_IDENTIFIERS.helper);
const TERMINAL = signer('com.googlecode.iterm2', 'H7V7XYVQ7D');
const row = (pid: number, parentPid: number, exe: string, mark: string | CodeSigner): SignedSnapshot => Object.freeze({ pid, uid,
  pidVersion: 1, uniqueId: String(pid * 10), parentPid, parentUniqueId: parentPid === 1 ? '1' : String(parentPid * 10), exe,
  sha256: typeof mark === 'string' ? mark.repeat(64) : null, signing: typeof mark === 'string' ? null : mark });
const wrappers = [{ path: '/opt/python', sha256: 'a'.repeat(64) }, { path: '/bin/sh', sha256: 'c'.repeat(64) }];

function world(rows: readonly SignedSnapshot[]) {
  const processes = new Map(rows.map(item => [item.pid, item]));
  const reads: number[] = [];
  const inspect = async (pid: number) => { reads.push(pid); return processes.get(pid) ?? null; };
  const peer = { pid: rows[0].pid, uid, pidVersion: 1 };
  return { processes, reads, inspect, resolve: () => resolveClaudeIdentity(peer, inspect, wrappers) };
}

const standalone = (base: number, cli: CodeSigner = CLI, exe = '/Users/u/.local/share/claude/versions/2.1.306') => [
  row(base + 2, base + 1, '/opt/python', 'a'), row(base + 1, base, '/bin/sh', 'c'), row(base, base - 1, exe, cli),
  row(base - 1, base - 2, '/bin/zsh', 'd'), row(base - 2, 1, '/Applications/iTerm.app/Contents/MacOS/iTerm2', TERMINAL)];
const hosted = (base: number) => [row(base + 2, base, '/opt/python', 'a'),
  row(base, base - 1, '/Users/u/Library/Application Support/Claude/claude-code/2.1.304/x/claude.app/Contents/MacOS/claude', CLI),
  row(base - 1, base - 2, '/Applications/Claude.app/Contents/Helpers/disclaimer', HELPER),
  row(base - 2, 1, '/Applications/Claude.app/Contents/MacOS/Claude', APP)];

test('a standalone Anthropic-signed CLI behind pinned wrappers is the identity, whatever its version path', async () => {
  for (const exe of ['/Users/u/.local/share/claude/versions/2.1.306', '/Users/u/.local/share/claude/versions/9.9.9', '/opt/elsewhere/claude']) {
    const w = world(standalone(100, CLI, exe));
    const { snapshot, surface } = await w.resolve();
    assert.deepEqual([snapshot.pid, snapshot.exe, surface], [100, exe, 'cli']);
    assert.deepEqual(w.reads, [102, 101, 100, 99, 98, 98, 99, 100, 101, 102]);
  }
});

test('a CLI under disclaimer and Claude.app is the desktop surface and the walk stops at the App', async () => {
  const w = world(hosted(200));
  const { snapshot, surface } = await w.resolve();
  assert.deepEqual([snapshot.pid, surface], [200, 'desktop']);
  assert.deepEqual(w.reads, [202, 200, 199, 198, 198, 199, 200, 202]);
});

test('anything other than an Anthropic Developer ID CLI with hardened runtime at the CLI position is UNKNOWN_CLAUDE_BINARY', async () => {
  const cases = [
    [row(302, 301, '/opt/python', 'a'), row(301, 1, '/opt/rogue', '7')],
    [row(302, 301, '/opt/python', 'a'), row(301, 1, '/opt/claude', signer(CLAUDE_IDENTIFIERS.cli, 'ABCDE12345'))],
    [row(302, 301, '/opt/python', 'a'), row(301, 1, '/opt/claude', signer('com.anthropic.other'))],
    [row(302, 301, '/opt/python', 'a'), row(301, 1, '/opt/claude', signer(CLAUDE_IDENTIFIERS.cli, ANTHROPIC_TEAM_ID, false))],
    [row(302, 301, '/opt/python', 'a'), row(301, 1, '/Applications/Claude.app/Contents/MacOS/Claude', APP)],
    [row(302, 301, '/opt/python', 'a'), row(301, 300, '/bin/bash', 'e'), row(300, 1, '/opt/claude', CLI)],
    [row(302, 301, '/opt/python', 'b'), row(301, 1, '/opt/claude', CLI)],
  ];
  for (const rows of cases) await assert.rejects(world(rows).resolve(), /^Error: UNKNOWN_CLAUDE_BINARY$/);
});

test('a standalone CLI with any Claude process further up, or a broken App chain, is rejected', async () => {
  const viaApp = [row(402, 400, '/opt/python', 'a'), row(400, 399, '/opt/claude', CLI), row(399, 398, '/bin/zsh', 'd'),
    row(398, 1, '/Applications/Claude.app/Contents/MacOS/Claude', APP)];
  await assert.rejects(world(viaApp).resolve(), /INVALID_CLI_ANCESTRY/);
  const nested = [row(412, 410, '/opt/python', 'a'), row(410, 409, '/opt/claude', CLI), row(409, 408, '/bin/zsh', 'd'),
    row(408, 1, '/opt/claude', CLI)];
  await assert.rejects(world(nested).resolve(), /INVALID_CLI_ANCESTRY/);
  const helperOnly = [row(422, 420, '/opt/python', 'a'), row(420, 419, '/opt/claude', CLI),
    row(419, 1, '/Applications/Claude.app/Contents/Helpers/disclaimer', HELPER)];
  await assert.rejects(world(helperOnly).resolve(), /INVALID_APP_ANCESTRY/);
  const helperThenShell = [row(432, 430, '/opt/python', 'a'), row(430, 429, '/opt/claude', CLI),
    row(429, 428, '/Applications/Claude.app/Contents/Helpers/disclaimer', HELPER), row(428, 1, '/bin/zsh', 'd')];
  await assert.rejects(world(helperThenShell).resolve(), /INVALID_APP_ANCESTRY/);
});

test('linkage, uid, peer generation and snapshot shape are fail-closed', async () => {
  const broken = standalone(500).map(item => item.pid === 500 ? { ...item, uniqueId: '777' } : item);
  await assert.rejects(world(broken).resolve(), /INVALID_PEER_IDENTITY/);
  const foreign = standalone(510).map(item => item.pid === 511 ? { ...item, uid: 0 } : item);
  await assert.rejects(world(foreign).resolve(), /INVALID_PEER_IDENTITY/);
  const w = world(standalone(520));
  await assert.rejects(resolveClaudeIdentity({ pid: 522, uid, pidVersion: 2 }, w.inspect, wrappers), /INVALID_PEER_IDENTITY/);
  for (const bad of [{ sha256: null, signing: null }, { sha256: 'a'.repeat(64), signing: CLI }, { sha256: 'xyz', signing: null }]) {
    const rows = standalone(530).map(item => item.pid === 532 ? { ...item, ...bad } : item);
    await assert.rejects(world(rows as SignedSnapshot[]).resolve(), /INVALID_PEER_IDENTITY/);
  }
  const gone = world(standalone(540)); gone.processes.delete(538);
  await assert.rejects(gone.resolve(), /INVALID_PEER_IDENTITY/);
  const failing = world(standalone(550));
  await assert.rejects(resolveClaudeIdentity({ pid: 552, uid, pidVersion: 1 },
    async pid => { if (pid === 550) throw new Error('CODE_SIGNING_UNAVAILABLE'); return failing.processes.get(pid) ?? null; }, wrappers),
  /CODE_SIGNING_UNAVAILABLE/);
});

test('a process that changes between the walk and the re-read is rejected', async () => {
  const w = world(standalone(600));
  let reads = 0;
  const inspect = async (pid: number) => {
    const current = w.processes.get(pid) ?? null;
    if (pid === 600 && ++reads === 2 && current) return { ...current, pidVersion: 9 };
    return current;
  };
  await assert.rejects(resolveClaudeIdentity({ pid: 602, uid, pidVersion: 1 }, inspect, wrappers), /INVALID_PEER_IDENTITY/);
});

const CLAUDE_EXE = '/Users/u/.local/share/claude/versions/2.1.310';
const APP_EXE = '/Applications/Claude.app/Contents/MacOS/Claude';
const HOST_EXE = '/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper';
const PANEL_HOST = signer('com.anthropic.claudefordesktop.helper');
const owned = (item: SignedSnapshot, owner: number): SignedSnapshot => Object.freeze({ ...item, uid: owner });
const login = (pid: number, parentPid: number) => owned(row(pid, parentPid, '/usr/bin/login', 'f'), 0);

test('a CLI behind a root-owned login, as Ghostty, Terminal.app, iTerm2 and screen start shells, is standalone', async () => {
  const terminals = [row(697, 1, '/Applications/Ghostty.app/Contents/MacOS/ghostty', signer('com.mitchellh.ghostty', '24VZTF6M5V')),
    row(697, 1, '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal', '1'),
    row(697, 1, '/Applications/iTerm.app/Contents/MacOS/iTerm2', TERMINAL), row(697, 1, '/usr/bin/screen', '2')];
  for (const terminal of terminals) {
    const w = world([row(702, 700, '/opt/python', 'a'), row(700, 699, CLAUDE_EXE, CLI), row(699, 698, '/bin/zsh', 'd'),
      login(698, 697), terminal]);
    const { snapshot, surface } = await w.resolve();
    assert.deepEqual([snapshot.pid, surface], [700, 'cli']);
    assert.deepEqual(w.reads, [702, 700, 699, 698, 697, 697, 698, 699, 700, 702]);
  }
});

test('the walk continues above a root-owned login, so a Claude process further up is still found', async () => {
  const w = world([row(802, 800, '/opt/python', 'a'), row(800, 799, CLAUDE_EXE, CLI), row(799, 798, '/bin/zsh', 'd'),
    login(798, 797), row(797, 796, '/bin/zsh', 'd'), ...hosted(796).slice(1)]);
  await assert.rejects(w.resolve(), /^Error: INVALID_CLI_ANCESTRY$/);
  assert.deepEqual(w.reads, [802, 800, 799, 798, 797, 796]);
});

const panel = (base: number, between: readonly SignedSnapshot[] = [row(base - 1, base - 2, '/bin/zsh', 'd')]) => {
  const host = base - 1 - between.length;
  return [row(base + 2, base, '/opt/python', 'a'), row(base, base - 1, CLAUDE_EXE, CLI), ...between,
    row(host, host - 1, HOST_EXE, PANEL_HOST), row(host - 1, 1, APP_EXE, APP)];
};

test('a CLI started in the Claude App terminal panel, behind a shell, the App helper and Claude.app, is standalone', async () => {
  const w = world(panel(900));
  const { snapshot, surface } = await w.resolve();
  assert.deepEqual([snapshot.pid, surface], [900, 'cli']);
  assert.deepEqual(w.reads, [902, 900, 899, 898, 897, 897, 898, 899, 900, 902]);
  const twoShells = await world(panel(920, [row(919, 918, '/bin/zsh', 'd'), row(918, 917, '/bin/bash', 'e')])).resolve();
  assert.deepEqual([twoShells.snapshot.pid, twoShells.surface], [920, 'cli']);
  const elsewhere = panel(940).map(item => item.pid === 938 ? { ...item, exe: `/Users/u${HOST_EXE}` } : item);
  assert.deepEqual((await world(elsewhere).resolve()).surface, 'cli');
});

test('only the exact panel shape ends a standalone walk at Claude.app', async () => {
  const at = (rows: readonly SignedSnapshot[], pid: number, change: Partial<SignedSnapshot>) =>
    rows.map(item => item.pid === pid ? Object.freeze({ ...item, ...change }) : item);
  const cases: Record<string, readonly SignedSnapshot[]> = {
    'CLI directly under the helper': [row(1002, 1000, '/opt/python', 'a'), row(1000, 999, CLAUDE_EXE, CLI),
      row(999, 998, HOST_EXE, PANEL_HOST), row(998, 1, APP_EXE, APP)],
    'Anthropic-signed direct parent': at(panel(1010), 1009, { sha256: null, signing: signer('com.anthropic.other') }),
    'helper parent is a shell': [...panel(1020).slice(0, 4).map(item => item.pid === 1018 ? { ...item, parentPid: 1017,
      parentUniqueId: '10170' } : item), row(1017, 1016, '/bin/zsh', 'd'), row(1016, 1, APP_EXE, APP)],
    'helper parent is launchd': [...panel(1030).slice(0, 4).map(item => item.pid === 1028 ? { ...item, parentPid: 1,
      parentUniqueId: '1' } : item)],
    'helper under another helper': [...panel(1040).slice(0, 4).map(item => item.pid === 1038 ? { ...item, parentPid: 1037,
      parentUniqueId: '10370' } : item), row(1037, 1036, HOST_EXE, PANEL_HOST), row(1036, 1, APP_EXE, APP)],
    'helper under disclaimer': [...panel(1050).slice(0, 4).map(item => item.pid === 1048 ? { ...item, parentPid: 1047,
      parentUniqueId: '10470' } : item), row(1047, 1046, '/Applications/Claude.app/Contents/Helpers/disclaimer', HELPER),
    row(1046, 1, APP_EXE, APP)],
    'helper with another team': at(panel(1060), 1058, { signing: signer('com.anthropic.claudefordesktop.helper', 'ABCDE12345') }),
    // Synthetic: no real App helper carries this identifier; all four helper programs share the terminal host one.
    'helper with a non-helper identifier (synthetic)': at(panel(1070), 1068, { signing: signer('com.anthropic.claudefordesktop.other') }),
    ...Object.fromEntries(['Renderer', 'GPU', 'Plugin'].map((kind, index) => [`the ${kind} helper, same identifier`,
      at(panel(1150 + index * 10), 1148 + index * 10,
        { exe: `/Applications/Claude.app/Contents/Frameworks/Claude Helper (${kind}).app/Contents/MacOS/Claude Helper (${kind})` })])),
    'helper without hardened runtime': at(panel(1080), 1078, { signing: signer('com.anthropic.claudefordesktop.helper', ANTHROPIC_TEAM_ID, false) }),
    'App without hardened runtime': at(panel(1090), 1087, { signing: signer(CLAUDE_IDENTIFIERS.app, ANTHROPIC_TEAM_ID, false) }),
    'helper of another uid': at(panel(1100), 1098, { uid: 502 }),
    'App of another uid': at(panel(1110), 1107, { uid: 502 }),
    'CLI in the Bash of a panel CLI': panel(1120, [row(1119, 1118, '/bin/zsh', 'd'), row(1118, 1117, CLAUDE_EXE, CLI),
      row(1117, 1116, '/bin/zsh', 'd')]),
    'CLI in the Bash of an App-hosted CLI': [row(1132, 1130, '/opt/python', 'a'), row(1130, 1129, CLAUDE_EXE, CLI),
      row(1129, 1128, '/bin/zsh', 'd'), ...hosted(1128).slice(1)],
    'disclaimer between the shell and the App': [row(1142, 1140, '/opt/python', 'a'), row(1140, 1139, CLAUDE_EXE, CLI),
      row(1139, 1138, '/bin/zsh', 'd'), row(1138, 1137, '/Applications/Claude.app/Contents/Helpers/disclaimer', HELPER),
      row(1137, 1, APP_EXE, APP)],
  };
  for (const [name, rows] of Object.entries(cases)) {
    await assert.rejects(world(rows).resolve(), /^Error: INVALID_CLI_ANCESTRY$/, name);
  }
});

// Agent view: the supervisor runs each background session's terminal in a pty host, and both are the same
// Anthropic-signed CLI binary as the session. The pty host may be adopted by launchd after the supervisor is replaced.
const PTY_EXE = '/Users/u/.local/share/claude/ClaudeCode.app/Contents/MacOS/claude';
const supervised = (base: number, top: readonly SignedSnapshot[] = []) => [row(base + 2, base, '/opt/python', 'a'),
  row(base, base - 1, CLAUDE_EXE, CLI), row(base - 1, base - 2, PTY_EXE, CLI),
  row(base - 2, top[0]?.pid ?? 1, CLAUDE_EXE, CLI), ...top];

test('a background session under its pty host and the agent view supervisor is a CLI, and the walk stops at the supervisor', async () => {
  const shapes: Record<string, readonly SignedSnapshot[]> = {
    'supervisor adopted by launchd': supervised(1200),
    'supervisor under the foreground CLI that spawned it': supervised(1200, [row(1197, 1196, CLAUDE_EXE, CLI),
      row(1196, 1195, '/bin/zsh', 'd'), login(1195, 1194), row(1194, 1, '/Applications/Ghostty.app/Contents/MacOS/ghostty', '3')]),
    'new supervisor under the old one while it upgrades': supervised(1200, [row(1197, 1, CLAUDE_EXE, CLI)]),
    'supervisor spawned from an App-hosted CLI': supervised(1200, hosted(1197).slice(1)),
  };
  for (const [name, rows] of Object.entries(shapes)) {
    const w = world(rows);
    const { snapshot, surface } = await w.resolve();
    assert.deepEqual([snapshot.pid, surface], [1200, 'cli'], name);
    assert.deepEqual(w.reads, [1202, 1200, 1199, 1198, 1198, 1199, 1200, 1202], name);
  }
});

test('a background session whose pty host launchd adopted, after the supervisor was replaced, is a CLI', async () => {
  const w = world(supervised(1210).slice(0, 3).map(item => item.pid === 1209 ? { ...item, parentPid: 1, parentUniqueId: '1' } : item));
  const { snapshot, surface } = await w.resolve();
  assert.deepEqual([snapshot.pid, surface], [1210, 'cli']);
  assert.deepEqual(w.reads, [1212, 1210, 1209, 1209, 1210, 1212]);
});

test('only an Anthropic CLI pty host under an Anthropic CLI supervisor or launchd hosts a background session', async () => {
  const at = (rows: readonly SignedSnapshot[], pid: number, change: Partial<SignedSnapshot>) =>
    rows.map(item => item.pid === pid ? Object.freeze({ ...item, ...change }) : item);
  const above = (base: number, top: readonly SignedSnapshot[]) => supervised(base).slice(0, 3)
    .map(item => item.pid === base - 1 ? { ...item, parentPid: top[0].pid, parentUniqueId: String(top[0].pid * 10) } : item)
    .concat(top);
  const cases: Record<string, readonly SignedSnapshot[]> = {
    'exec claude in the Bash of a terminal CLI': above(1300, [row(1298, 1297, '/bin/zsh', 'd'), login(1297, 1296),
      row(1296, 1, '/Applications/Ghostty.app/Contents/MacOS/ghostty', '3')]),
    'exec claude in the Bash of an App-hosted CLI': above(1310, hosted(1308).slice(2)),
    'pty host under the App helper': above(1320, [row(1318, 1317, HOST_EXE, PANEL_HOST), row(1317, 1, APP_EXE, APP)]),
    'pty host under Claude.app': above(1330, [row(1328, 1, APP_EXE, APP)]),
    'pty host under an unsigned program': above(1340, [row(1338, 1, '/opt/launcher', '4')]),
    'pty host under a signed terminal': above(1350, [row(1348, 1, '/Applications/iTerm.app/Contents/MacOS/iTerm2', TERMINAL)]),
    'pty host of another uid': at(supervised(1360), 1359, { uid: 502 }),
    'supervisor of another uid': at(supervised(1370), 1368, { uid: 502 }),
    'pty host with another team': at(supervised(1380), 1379, { signing: signer(CLAUDE_IDENTIFIERS.cli, 'ABCDE12345') }),
    'pty host without hardened runtime': at(supervised(1390), 1389, { signing: signer(CLAUDE_IDENTIFIERS.cli, ANTHROPIC_TEAM_ID, false) }),
    'pty host with another identifier': at(supervised(1400), 1399, { signing: signer('com.anthropic.other') }),
    'supervisor with another team': at(supervised(1410), 1408, { signing: signer(CLAUDE_IDENTIFIERS.cli, 'ABCDE12345') }),
    'supervisor without hardened runtime': at(supervised(1420), 1418, { signing: signer(CLAUDE_IDENTIFIERS.cli, ANTHROPIC_TEAM_ID, false) }),
    'supervisor with the disclaimer identifier': at(supervised(1430), 1428, { signing: HELPER }),
    'unlinked pty host': at(supervised(1440), 1439, { uniqueId: '777' }),
    'unlinked supervisor': at(supervised(1450), 1448, { uniqueId: '778' }),
    'claude started in the Bash of a background session': [row(1462, 1460, '/opt/python', 'a'), row(1460, 1459, CLAUDE_EXE, CLI),
      row(1459, 1458, '/bin/zsh', 'd'), ...supervised(1458).slice(1)],
  };
  for (const [name, rows] of Object.entries(cases)) {
    await assert.rejects(world(rows).resolve(), /^Error: INVALID_CLI_ANCESTRY$/, name);
  }
});

test('a supervisor that changes between the walk and the re-read is rejected', async () => {
  const w = world(supervised(1500));
  let reads = 0;
  const inspect = async (pid: number) => {
    const current = w.processes.get(pid) ?? null;
    if (pid === 1498 && ++reads === 2 && current) return { ...current, parentPid: 1497, parentUniqueId: '14970' };
    return current;
  };
  await assert.rejects(resolveClaudeIdentity({ pid: 1502, uid, pidVersion: 1 }, inspect, wrappers), /INVALID_PEER_IDENTITY/);
});
