// INPUT: Synthetic ms argv vectors and a fixed working directory.
// OUTPUT: Command/request mapping and fixed usage-error regressions.
// POS: Pure CLI boundary tests; no socket, launchd, files or host.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArgs } from '../../src/cli/args.ts';

const CWD = '/work/repo';
const parse = (argv: string[]) => parseArgs(argv, CWD);
const control = (view: string, method: string, params: Record<string, unknown>, json = false) =>
  ({ kind: 'control', view, method, params, json });

test('management commands map to exact control requests', () => {
  assert.deepEqual(parse(['status']), control('status', 'status', {}));
  assert.deepEqual(parse(['sessions', '--harness', 'dsh', '--json']), control('sessions', 'sessions.list', { harness: 'dsh' }, true));
  assert.deepEqual(parse(['sessions']), control('sessions', 'sessions.list', {}));
  assert.deepEqual(parse(['links']), control('links', 'links.list', {}));
  assert.deepEqual(parse(['messages', '--link', 'L1', '--limit', '200']), control('messages', 'messages.list', { linkId: 'L1', limit: 200 }));
  assert.deepEqual(parse(['messages']), control('messages', 'messages.list', {}));
  assert.deepEqual(parse(['config', 'get']), control('config', 'config.get', {}));
});

test('project directory, aliases and link resume map to their control methods', () => {
  assert.deepEqual(parse(['sessions', '--project', '.', '--harness', 'claude-code']),
    control('sessions', 'sessions.list', { harness: 'claude-code', project: '/work/repo' }));
  assert.deepEqual(parse(['sessions', '--project', '/abs/p/../q']), control('sessions', 'sessions.list', { project: '/abs/q' }));
  assert.deepEqual(parse(['sessions', '--project', 'agent-message-switchboard']),
    control('sessions', 'sessions.list', { project: 'agent-message-switchboard' }));
  assert.deepEqual(parse(['projects', '--json']), control('projects', 'projects.list', {}, true));
  assert.deepEqual(parse(['alias', 'dsh', 'S-1', '文档同步']),
    control('alias', 'sessions.alias', { harness: 'dsh', sessionId: 'S-1', alias: '文档同步' }));
  assert.deepEqual(parse(['alias', 'dsh', 'S-1', '--clear', '--json']),
    control('alias', 'sessions.alias', { harness: 'dsh', sessionId: 'S-1', alias: null }, true));
  assert.deepEqual(parse(['links', 'resume', 'L9']), control('link-resume', 'links.resume', { linkId: 'L9' }));
});

test('config set covers auto-register per harness, all harnesses, per project, the reply mode, the act preset and the link budget', () => {
  assert.deepEqual(parse(['config', 'set', 'auto-register', 'on']),
    control('config', 'config.set', { autoRegister: { 'claude-code': true, dsh: true, codex: true } }));
  assert.deepEqual(parse(['config', 'set', 'auto-register', '--harness', 'claude-code', 'on']),
    control('config', 'config.set', { autoRegister: { 'claude-code': true } }));
  assert.deepEqual(parse(['config', 'set', 'auto-register', 'off', '--harness', 'claude-code']),
    control('config', 'config.set', { autoRegister: { 'claude-code': false } }));
  assert.deepEqual(parse(['config', 'set', 'auto-register', '--project', 'sub', 'on']),
    control('config', 'config.set', { autoRegisterProjects: { add: ['/work/repo/sub'] } }));
  assert.deepEqual(parse(['config', 'set', 'auto-register', '--project', '/p', 'off', '--json']),
    control('config', 'config.set', { autoRegisterProjects: { remove: ['/p'] } }, true));
  assert.deepEqual(parse(['config', 'set', 'link-budget', '--window-seconds', '600', '--max-pushes', '30', '--json']),
    control('config', 'config.set', { linkBudget: { windowSeconds: 600, maxPushes: 30 } }, true));
  assert.deepEqual(parse(['config', 'set', 'reply-mode', 'confirm']),
    control('config', 'config.set', { replyMode: { 'claude-code': 'confirm', dsh: 'confirm', codex: 'confirm' } }));
  assert.deepEqual(parse(['config', 'set', 'reply-mode', '--harness', 'dsh', 'direct', '--json']),
    control('config', 'config.set', { replyMode: { dsh: 'direct' } }, true));
  assert.deepEqual(parse(['config', 'set', 'reply-mode', 'confirm', '--harness', 'codex']),
    control('config', 'config.set', { replyMode: { codex: 'confirm' } }));
  assert.deepEqual(parse(['config', 'set', 'reply-mode', 'act']),
    control('config', 'config.set', { replyMode: { 'claude-code': 'act', dsh: 'act', codex: 'act' } }));
  assert.deepEqual(parse(['config', 'set', 'act-preset', 'read-only']),
    control('config', 'config.set', { actPreset: { 'claude-code': 'read-only', dsh: 'read-only', codex: 'read-only' } }));
  assert.deepEqual(parse(['config', 'set', 'act-preset', '--harness', 'codex', 'full-access', '--json']),
    control('config', 'config.set', { actPreset: { codex: 'full-access' } }, true));
  assert.deepEqual(parse(['config', 'set', 'act-preset', 'workspace-write', '--harness', 'claude-code']),
    control('config', 'config.set', { actPreset: { 'claude-code': 'workspace-write' } }));
});

test('install, uninstall, daemon, ui and help commands', () => {
  assert.deepEqual(parse(['install']), { kind: 'install', dryRun: false, harness: null });
  assert.deepEqual(parse(['install', '--dry-run']), { kind: 'install', dryRun: true, harness: null });
  assert.deepEqual(parse(['install', '--harness', 'dsh', '--dry-run']), { kind: 'install', dryRun: true, harness: 'dsh' });
  assert.deepEqual(parse(['repin']), { kind: 'repin', dryRun: false });
  assert.deepEqual(parse(['repin', '--dry-run']), { kind: 'repin', dryRun: true });
  assert.deepEqual(parse(['uninstall', '--dry-run']), { kind: 'uninstall', dryRun: true, keepData: false, harness: null });
  assert.deepEqual(parse(['uninstall', '--keep-data', '--dry-run']), { kind: 'uninstall', dryRun: true, keepData: true, harness: null });
  assert.deepEqual(parse(['uninstall']), { kind: 'uninstall', dryRun: false, keepData: false, harness: null });
  assert.deepEqual(parse(['uninstall', '--harness', 'claude-code']), { kind: 'uninstall', dryRun: false, keepData: false, harness: 'claude-code' });
  for (const action of ['start', 'stop', 'status'] as const) {
    assert.deepEqual(parse(['daemon', action]), { kind: 'daemon', action });
  }
  assert.deepEqual(parse(['ui']), { kind: 'ui' });
  assert.deepEqual(parse(['upgrade']), { kind: 'upgrade', dryRun: false });
  assert.deepEqual(parse(['upgrade', '--dry-run']), { kind: 'upgrade', dryRun: true });
  assert.deepEqual(parse([]), { kind: 'help' });
  assert.deepEqual(parse(['help']), { kind: 'help' });
  assert.deepEqual(parse(['--help']), { kind: 'help' });
});

test('malformed argv fails closed with USAGE_INVALID', () => {
  const cases = [
    ['bogus'], ['sessions', '--harness', 'claude'], ['alias', 'claude', 'S', 'n'], ['config', 'set', 'auto-register', '--harness', 'claude', 'on'],
    ['status', 'extra'], ['status', '--harness', 'dsh'], ['sessions', '--harness', 'web'],
    ['sessions', '--harness'], ['sessions', '--harness', 'dsh', '--harness', 'claude-code'], ['sessions', '--project'],
    ['messages', '--limit', '0'], ['messages', '--limit', '201'], ['messages', '--limit', '1.5'], ['messages', '--limit', '07'],
    ['messages', '--link', ''], ['projects', 'x'], ['alias'], ['alias', 'dsh', 'S'], ['alias', 'web', 'S', 'n'],
    ['alias', 'dsh', 'S', 'n', 'extra'], ['alias', 'dsh', '', 'n'], ['alias', 'dsh', 'S', ''], ['alias', 'dsh', 'S', 'n', '--clear'],
    ['alias', 'dsh', 'S', '--clear', '--clear'], ['links', 'resume'],
    ['links', 'resume', 'L', 'M'], ['links', 'pause', 'L'],
    ['config'], ['config', 'put'], ['config', 'set'], ['config', 'set', 'auto-register'], ['config', 'set', 'auto-register', 'yes'],
    ['config', 'set', 'auto-register', 'on', 'off'], ['config', 'set', 'auto-register', '--harness', 'dsh', '--project', '/p', 'on'],
    ['config', 'set', 'link-budget', '--window-seconds', '600'], ['config', 'set', 'link-budget', '--window-seconds', '-1', '--max-pushes', '3'],
    ['config', 'set', 'link-budget', '--window-seconds', '600', '--max-pushes', '0'], ['config', 'set', 'other', 'x'],
    ['config', 'set', 'reply-mode'], ['config', 'set', 'reply-mode', 'on'], ['config', 'set', 'reply-mode', 'status'],
    ['config', 'set', 'reply-mode', 'Direct'], ['config', 'set', 'reply-mode', 'direct', 'confirm'],
    ['config', 'set', 'reply-mode', '--harness', 'claude', 'direct'], ['config', 'set', 'reply-mode', '--project', '/p', 'direct'],
    ['config', 'set', 'reply-mode', '--harness', 'dsh', '--harness', 'codex', 'direct'], ['config', 'set', 'reply', 'direct'],
    ['config', 'set', 'act-preset'], ['config', 'set', 'act-preset', 'danger-full-access'], ['config', 'set', 'act-preset', 'Read-only'],
    ['config', 'set', 'act-preset', 'read-only', 'full-access'], ['config', 'set', 'act-preset', 'act'],
    ['config', 'set', 'act-preset', '--harness', 'claude', 'read-only'], ['config', 'set', 'act-preset', '--project', '/p', 'read-only'],
    ['config', 'set', 'act-preset', '--harness', 'dsh', '--harness', 'codex', 'read-only'], ['config', 'set', 'preset', 'read-only'],
    ['install', '--force'], ['install', '--keep-data'], ['install', '--harness', 'claude'], ['install', '--harness'], ['repin', '--harness', 'dsh'],
    ['uninstall', '--harness', 'dsh', '--keep-data'], ['uninstall', '--harness', 'web'], ['repin', '--keep-data'], ['repin', 'now'], ['uninstall', 'now'], ['daemon'], ['daemon', 'restart'],
    ['daemon', 'start', '--json'], ['install', '--dry-run', '--dry-run'], ['links', '--json=1'],
    ['ui', '--json'], ['ui', 'now'], ['ui', '--no-open'], ['ui', ''],
    ['upgrade', '--dry-run', '--dry-run'], ['upgrade', '--keep-data'], ['upgrade', 'now'],
  ];
  for (const argv of cases) assert.throws(() => parse(argv), { message: 'USAGE_INVALID' }, argv.join(' '));
});
