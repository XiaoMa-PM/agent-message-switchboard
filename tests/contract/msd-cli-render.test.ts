// INPUT: A real msd control server (switchboard, config store, control methods) on a private temp socket and the real CLI entry.
// OUTPUT: Contract that the config-bearing views a real msd returns (status, config get, config set) pass the CLI's exact-shape
//         validation in human and JSON output, so a daemon field cannot be added without the CLI accepting it;
//         the text shows the act presets, and reply-mode act without --harness reaches all three.
// POS: msd ↔ CLI contract; no host, broker, launchd or model.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, type CliDeps } from '../../src/cli/main.ts';
import { resolvePaths } from '../../src/cli/paths.ts';
import { writeDaemonConfig, type DaemonConfig } from '../../src/daemon/config.ts';
import { createConfigStore, createControlMethods } from '../../src/daemon/control-methods.ts';
import { listenControl } from '../../src/daemon/control-server.ts';
import { createSwitchboard } from '../../src/daemon/switchboard.ts';

const pin = (name: string, digit: string) => ({ path: `/opt/${name}`, sha256: digit.repeat(64) });
const config: DaemonConfig = Object.freeze({ schemaVersion: 4, python: pin('python', 'a'), claude: { wrapperPins: [] },
  autoRegister: { 'claude-code': false, dsh: true, codex: false }, autoRegisterProjects: ['/repo'],
  replyMode: { 'claude-code': 'direct', dsh: 'confirm', codex: 'direct' } as const,
  actPreset: { 'claude-code': 'read-only', dsh: 'workspace-write', codex: 'full-access' } as const,
  linkBudget: { windowSeconds: 600, maxPushes: 30 } });

function cliDeps(socket: string): { deps: CliDeps; out: string[]; err: string[] } {
  const out: string[] = []; const err: string[] = [];
  const unused = async () => { throw new Error('not used'); };
  return { out, err, deps: { io: { out: text => out.push(text), err: text => err.push(text) }, cwd: '/repo', controlTimeoutMs: 2000,
    paths: { ...resolvePaths('/tmp/ms-home-unused'), socket },
    handlers: { install: unused, repin: unused, uninstall: unused, daemon: unused, ui: unused, upgrade: unused } } };
}

test('status, config get and config set from a real msd render through the real CLI, human and JSON', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ms-render-'));
  const run = join(root, 'run'); await mkdir(run, { mode: 0o700 });
  const configPath = join(root, 'config.json');
  await writeDaemonConfig(configPath, config);
  const board = createSwitchboard();
  const store = createConfigStore(configPath, config, next => board.setBudget(next.linkBudget));
  const server = await listenControl(join(run, 'msd.sock'), createControlMethods({ board, config: store, version: '0.1.0-test',
    startedAt: '2026-10-25T00:00:00.000Z', projectOf: async cwd => cwd }));
  try {
    for (const argv of [['status'], ['config', 'get'], ['config', 'set', 'reply-mode', 'direct', '--harness', 'dsh']]) {
      for (const json of [false, true]) {
        const cli = cliDeps(join(run, 'msd.sock'));
        const command = json ? [...argv, '--json'] : argv;
        assert.equal(await runCli(command, cli.deps), 0, `${command.join(' ')}: ${cli.err.join('')}`);
        assert.deepEqual(cli.err, []);
        if (json) assert.deepEqual(JSON.parse(cli.out.join('')).actPreset, config.actPreset, command.join(' '));
        else assert.match(cli.out.join(''), /\nact-preset: claude-code read-only, dsh workspace-write, codex full-access(\n|$)/, command.join(' '));
      }
    }
    const set = cliDeps(join(run, 'msd.sock'));
    assert.equal(await runCli(['config', 'set', 'act-preset', '--harness', 'dsh', 'read-only'], set.deps), 0, set.err.join(''));
    assert.match(set.out.join(''), /\nact-preset: claude-code read-only, dsh read-only, codex full-access\n/);
    // Codex is in ACT_HARNESSES, so act without --harness reaches all three.
    const act = cliDeps(join(run, 'msd.sock'));
    assert.equal(await runCli(['config', 'set', 'reply-mode', 'act'], act.deps), 0, act.err.join(''));
    assert.deepEqual(store.get().replyMode, { 'claude-code': 'act', dsh: 'act', codex: 'act' });
  } finally { await server.close(); }
});
