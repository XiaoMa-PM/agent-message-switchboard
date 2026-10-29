// INPUT: Synthetic thread IDs, lsof field output and process facts.
// OUTPUT: Regressions for writer-lock paths, holder parsing, owner checks, client surface and exec-server detection.
// POS: Offline owner-probe tests; real lsof/Codex ownership is verified only in host acceptance.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { holdsWriterLock, isRemoteExecutor, parseLsofPids, parsePsFacts, parseThreadId, surfaceOf, writerLockPath }
  from '../../src/adapters/codex/thread-owner.ts';

const THREAD = '01a1582e-3c00-7e81-9a44-3059358af07c';

test('thread IDs are exact lowercase UUIDs and map to the writer lock under codex home', () => {
  assert.equal(parseThreadId(THREAD), THREAD);
  for (const bad of [undefined, 7, '', THREAD.toUpperCase(), `${THREAD}/../x`, `../${THREAD}`, 'thread-1']) {
    assert.throws(() => parseThreadId(bad), /INVALID_THREAD_ID/);
  }
  assert.equal(writerLockPath('/home/u/.codex', THREAD), `/home/u/.codex/thread-writer-locks/${THREAD}.lock`);
  assert.throws(() => writerLockPath('relative/.codex', THREAD), /INVALID_CODEX_HOME/);
});

test('lsof field output yields unique holder pids and rejects malformed rows', () => {
  assert.deepEqual(parseLsofPids('p23263\nccodex\nf42\nau\nn/x.lock\n'), [23263]);
  assert.deepEqual(parseLsofPids('p10\nf3\np11\nf4\np10\n'), [10, 11]);
  assert.deepEqual(parseLsofPids(''), []);
  assert.throws(() => parseLsofPids('pabc\n'), /OWNER_PROBE_FAILED/);
  assert.throws(() => parseLsofPids('p1\n'), /OWNER_PROBE_FAILED/);
});

test('owner check requires the exact pid among holders of that thread lock only', async () => {
  const seen: string[] = [];
  const holders = (map: Record<string, number[]>) => async (path: string) => { seen.push(path); return map[path] ?? []; };
  const lock = writerLockPath('/c', THREAD);
  assert.equal(await holdsWriterLock(holders({ [lock]: [42] }), '/c', THREAD, 42), true);
  assert.equal(await holdsWriterLock(holders({ [lock]: [42, 77] }), '/c', THREAD, 42), true);
  assert.equal(await holdsWriterLock(holders({ [lock]: [77] }), '/c', THREAD, 42), false);
  assert.equal(await holdsWriterLock(holders({}), '/c', THREAD, 42), false);
  assert.ok(seen.every(path => path === lock));
  await assert.rejects(holdsWriterLock(holders({}), '/c', 'nope', 42), /INVALID_THREAD_ID/);
});

test('ps facts parse parent pid and executable with spaces; desktop surface only for an app main executable', () => {
  assert.deepEqual(parsePsFacts('  23169 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n'),
    { parentPid: 23169, executable: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT' });
  assert.deepEqual(parsePsFacts('1 /Applications/X.app/Contents/Helpers/Codex (Service).app/Contents/MacOS/Codex (Service)'),
    { parentPid: 1, executable: '/Applications/X.app/Contents/Helpers/Codex (Service).app/Contents/MacOS/Codex (Service)' });
  assert.deepEqual(parsePsFacts('    1 node\n'), { parentPid: 1, executable: 'node' });
  assert.deepEqual(parsePsFacts('    0 /sbin/launchd\n'), { parentPid: 0, executable: '/sbin/launchd' });
  assert.throws(() => parsePsFacts(''), /OWNER_PROBE_FAILED/);
  assert.throws(() => parsePsFacts('x /bin/zsh'), /OWNER_PROBE_FAILED/);
  assert.throws(() => parsePsFacts('12 '), /OWNER_PROBE_FAILED/);
  assert.equal(surfaceOf('/Applications/ChatGPT.app/Contents/MacOS/ChatGPT'), 'desktop');
  assert.equal(surfaceOf('/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'), 'cli');
  assert.equal(surfaceOf('/bin/zsh'), 'cli');
  assert.equal(surfaceOf('/sbin/launchd'), 'cli');
});

test('only a codex parent whose subcommand is exec-server counts as a remote executor', () => {
  const app = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
  assert.equal(isRemoteExecutor(app, `${app} -c forced_login_method="chatgpt" exec-server --remote https://e.invalid/api --environment-id e1`), true);
  assert.equal(isRemoteExecutor(app, `${app} --config a=b exec-server`), true);
  assert.equal(isRemoteExecutor('/opt/x y/codex', '/opt/x y/codex exec-server --listen ws://127.0.0.1:4500'), true);
  const daemon = '/Users/u/.codex/packages/app-server-daemon/releases/0.163.0-aarch64-apple-darwin/bin/codex';
  const tui = '/Users/u/.local/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/bin/codex';
  for (const [executable, line] of [
    [app, `${app} -c features.code_mode_host=true app-server --analytics-default-enabled -c a=b`],
    [daemon, `${daemon} app-server --listen unix:// --analytics-default-enabled --managed-daemon`],
    [tui, tui],
    [tui, `${tui} -c model="gpt-6-luna" -c model_reasoning_effort="low"`],
    [tui, `${tui} explain exec-server`],
    [tui, `${tui} -c`],
    ['/usr/bin/node', '/usr/bin/node exec-server'],
    [app, 'codex exec-server'],
    [app, ''],
  ]) assert.equal(isRemoteExecutor(executable, line), false, line);
});
