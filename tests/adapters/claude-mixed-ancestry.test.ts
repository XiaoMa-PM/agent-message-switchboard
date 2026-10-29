// INPUT: Synthetic kernel snapshots for standalone CLI, App-hosted CLI, App helpers and nested binaries.
// OUTPUT: Single-classifier dual-pin resolution and strict App/standalone ancestry regressions.
// POS: Pure mixed-entry identity contract tests; no OS reads, App, CLI or model.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveClaudePeerAmong, type ProcessSnapshot, type BinaryPin } from '../../src/adapters/claude/peer-identity.ts';
import { resolveAppAncestor, assertStandaloneAncestry } from '../../src/bridge/claude-ancestry.ts';

const pinOf = (path: string, digit: string): BinaryPin => Object.freeze({ path, sha256: digit.repeat(64) });
const standalonePin = pinOf('/fixture/claude-2.1.295', 'a');
const appCliPin = pinOf('/fixture/claude-2.1.299', 'b');
const appPin = pinOf('/fixture/Claude.app/Claude', 'c');
const helperPin = pinOf('/fixture/Claude.app/Helper', 'd');
const wrapperPin = pinOf('/fixture/python3', 'e');
let unique = 1000;
function row(pid: number, parent: ProcessSnapshot | null, pin: BinaryPin, uid = 501): ProcessSnapshot {
  unique += 1;
  return Object.freeze({ pid, uid, pidVersion: pid + 1, uniqueId: String(unique),
    parentPid: parent?.pid ?? 1, parentUniqueId: parent?.uniqueId ?? '1', exe: pin.path, sha256: pin.sha256 });
}
const lookup = (rows: readonly ProcessSnapshot[]) => async (pid: number) => rows.find(item => item.pid === pid) ?? null;
const samePin = (snapshot: ProcessSnapshot, pin: BinaryPin) => snapshot.exe === pin.path && snapshot.sha256 === pin.sha256;
const classify = (snapshot: ProcessSnapshot) => [standalonePin, appCliPin].some(pin => samePin(snapshot, pin)) ? 'cli' as const
  : samePin(snapshot, wrapperPin) ? 'wrapper' as const : 'unsupported' as const;
const token = (snapshot: ProcessSnapshot) => ({ pid: snapshot.pid, uid: snapshot.uid, pidVersion: snapshot.pidVersion });
const open = () => {};
const appOptions = (rows: readonly ProcessSnapshot[]) => ({ inspect: lookup(rows), appPin, appHelperPins: [helperPin], assertOpen: open });
const standaloneOptions = (rows: readonly ProcessSnapshot[]) => ({ inspect: lookup(rows),
  forbidden: [appPin, helperPin, standalonePin, appCliPin], assertOpen: open });

function standaloneTree() {
  const login = row(20, null, pinOf('/usr/bin/login', '1'), 0);
  const shell = row(21, login, pinOf('/bin/zsh', '2'));
  const cli = row(22, shell, standalonePin);
  const hook = row(23, cli, wrapperPin);
  return { rows: [login, shell, cli, hook], cli, hook };
}

function appTree() {
  const app = row(30, null, appPin);
  const helper = row(31, app, helperPin);
  const cli = row(32, helper, appCliPin);
  const hook = row(33, cli, wrapperPin);
  return { rows: [app, helper, cli, hook], app, helper, cli, hook };
}

test('one classifier resolves either CLI pin and reports which one matched', async () => {
  const standalone = standaloneTree(); const hosted = appTree();
  const pins = [standalonePin, appCliPin];
  const first = await resolveClaudePeerAmong(token(standalone.hook), lookup(standalone.rows), classify, pins);
  assert.deepEqual([first.pinIndex, first.snapshot.pid], [0, standalone.cli.pid]);
  const second = await resolveClaudePeerAmong(token(hosted.hook), lookup(hosted.rows), classify, pins);
  assert.deepEqual([second.pinIndex, second.snapshot.pid], [1, hosted.cli.pid]);
});

test('the nearest CLI node decides; an unpinned nearer Claude binary is never skipped as a wrapper', async () => {
  const standalone = standaloneTree();
  const nested = row(40, standalone.cli, pinOf('/fixture/claude-2.1.300', 'f'));
  const hook = row(41, nested, wrapperPin);
  const otherCli = (snapshot: ProcessSnapshot) => snapshot.exe.includes('claude-') ? 'cli' as const : classify(snapshot);
  await assert.rejects(resolveClaudePeerAmong(token(hook), lookup([...standalone.rows, nested, hook]), otherCli,
    [standalonePin, appCliPin]), /UNSUPPORTED_CLAUDE_BINARY/);
});

test('App-hosted CLI nested under a standalone CLI resolves to the inner App CLI and fails App ancestry', async () => {
  const standalone = standaloneTree();
  const inner = row(50, standalone.cli, appCliPin); const hook = row(51, inner, wrapperPin);
  const rows = [...standalone.rows, inner, hook];
  const resolved = await resolveClaudePeerAmong(token(hook), lookup(rows), classify, [standalonePin, appCliPin]);
  assert.deepEqual([resolved.pinIndex, resolved.snapshot.pid], [1, inner.pid]);
  await assert.rejects(resolveAppAncestor(resolved.snapshot, appOptions(rows)), /INVALID_APP_ANCESTRY/);
});

test('standalone CLI nested under any Claude binary, App or App helper is rejected', async () => {
  const hosted = appTree();
  for (const parent of [hosted.cli, hosted.helper, hosted.app]) {
    const nested = row(60 + parent.pid, parent, standalonePin); const hook = row(61 + parent.pid, nested, wrapperPin);
    const rows = [...hosted.rows, nested, hook];
    const resolved = await resolveClaudePeerAmong(token(hook), lookup(rows), classify, [standalonePin, appCliPin]);
    assert.equal(resolved.pinIndex, 0);
    await assert.rejects(assertStandaloneAncestry(resolved.snapshot, standaloneOptions(rows)), /INVALID_CLI_ANCESTRY/);
  }
  const standalone = standaloneTree();
  const outer = row(70, null, standalonePin); const shell = row(71, outer, pinOf('/bin/zsh', '2'));
  const inner = row(72, shell, standalonePin);
  await assert.rejects(assertStandaloneAncestry(inner, standaloneOptions([...standalone.rows, outer, shell, inner])),
    /INVALID_CLI_ANCESTRY/);
});

test('App-hosted CLI without an App ancestor is rejected', async () => {
  const shell = row(80, null, pinOf('/bin/zsh', '2')); const cli = row(81, shell, appCliPin);
  await assert.rejects(resolveAppAncestor(cli, appOptions([shell, cli])), /INVALID_APP_ANCESTRY/);
});

test('standalone ancestry walks to pid 1 across other users and accepts a clean chain', async () => {
  const standalone = standaloneTree();
  await assertStandaloneAncestry(standalone.cli, standaloneOptions(standalone.rows));
  const hosted = appTree();
  assert.deepEqual(await resolveAppAncestor(hosted.cli, appOptions(hosted.rows)), hosted.app);
});

test('a parent disappearing, changing or breaking continuity during standalone ancestry is rejected', async () => {
  const { rows, cli } = standaloneTree();
  const [login, shell] = rows;
  for (const changed of [
    rows.filter(item => item.pid !== shell.pid),
    rows.map(item => item.pid === shell.pid ? { ...shell, uniqueId: '999999' } : item),
    rows.map(item => item.pid === login.pid ? { ...login, uniqueId: '999998' } : item),
  ]) await assert.rejects(assertStandaloneAncestry(cli, standaloneOptions(changed)), /INVALID_CLI_ANCESTRY/);
  let reads = 0;
  const flipping = async (pid: number) => {
    reads += 1;
    if (pid === login.pid && reads > 2) return { ...login, sha256: '9'.repeat(64) };
    return rows.find(item => item.pid === pid) ?? null;
  };
  await assert.rejects(assertStandaloneAncestry(cli, { ...standaloneOptions(rows), inspect: flipping }), /INVALID_CLI_ANCESTRY/);
  await assert.rejects(assertStandaloneAncestry(cli, { ...standaloneOptions(rows),
    inspect: async () => { throw new Error('IO'); } }), /INVALID_CLI_ANCESTRY/);
});

test('ancestry walks stop as soon as the trusted open check fails', async () => {
  const { rows, cli } = standaloneTree();
  const closed = () => { throw new Error('ROUNDTRIP_STOPPED'); };
  await assert.rejects(assertStandaloneAncestry(cli, { ...standaloneOptions(rows), assertOpen: closed }), /ROUNDTRIP_STOPPED/);
  const hosted = appTree();
  await assert.rejects(resolveAppAncestor(hosted.cli, { ...appOptions(hosted.rows), assertOpen: closed }), /ROUNDTRIP_STOPPED/);
});
