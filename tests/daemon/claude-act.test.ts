// INPUT: Synthetic Claude hook payloads, a temporary letter-turn marker directory and a fixed act preset.
// OUTPUT: Act letter-turn markers kept by session id next to the socket-named fallback; settlement of each letter by its prompt_id.
// POS: Offline tests of src/daemon/claude-act.ts; no Claude, broker or socket.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeAct, MAINTENANCE_TASKS } from '../../src/daemon/claude-act.ts';
import { type ReceiptReason } from '../../src/protocol/receipt-text.ts';

const SID = '0f4c2a9e-6b1d-4e3a-9c8f-2d7b5a1e4c90';
const OTHER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
type Settled = Readonly<{ sessionId: string; letters: readonly string[]; reason: ReceiptReason }>;
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'ms-act-')); const markers = join(dir, 'letter-turns');
  const settled: Settled[] = [];
  const act = createClaudeAct({ preset: () => 'workspace-write', markers, home: '/home/u', projectOf: async cwd => cwd,
    settle: (sessionId, letters, reason) => { settled.push({ sessionId, letters, reason }); } });
  const hook = (sessionId: unknown, extra: Record<string, unknown> = {}) => ({ session_id: sessionId, permission_mode: 'default', ...extra });
  return { dir, markers, act, hook, settled, names: () => (existsSync(markers) ? readdirSync(markers).sort() : []),
    close: () => rm(dir, { recursive: true, force: true }) };
}

test('a letter turn is marked by session id and by socket name; a second process of the same session finds the id marker', async () => {
  const f = await fixture();
  try {
    assert.equal(await f.act.letterMode(f.hook(SID), '/tmp/claude-7.sock', 'x', 'm-1'), 'act');
    assert.deepEqual(f.names(), [SID, 'claude-7.sock'].sort());
    for (const name of f.names()) assert.equal(await readFile(join(f.markers, name), 'utf8'), SID);
    await f.act.sessionStart(f.hook(SID, { source: 'resume' }), '/tmp/claude-9.sock');
    assert.ok(f.names().includes(SID), 'the session id survives the new process and its new socket');
  } finally { await f.close(); }
});

test('a session id that is not a plain UUID writes no marker and the letter is direct', async () => {
  const f = await fixture();
  try {
    for (const sessionId of ['served:' + SID, '../' + SID, SID + '/x', 'abc', '', ' ' + SID, SID.replaceAll('-', ''), 7, null, undefined]) {
      assert.equal(await f.act.letterMode(f.hook(sessionId), '/tmp/claude-7.sock', 'x', 'm-1'), 'direct', String(sessionId));
    }
    assert.deepEqual(f.names(), []);
    assert.equal(await f.act.letterMode(f.hook(SID.toUpperCase()), '/tmp/claude-7.sock', 'x', 'm-1'), 'act', 'Claude keeps a --session-id as given');
  } finally { await f.close(); }
});

// SessionEnd leaves the id marker, because a respawn of a stuck attach or a confirmed restart
// in agent view runs SessionEnd (SIGTERM) and then resumes the in-flight turn under the same id; only Stop removes it.
test('SessionStart keeps every id marker and drops only a socket marker left there by another session; SessionEnd drops only socket ones', async () => {
  const f = await fixture();
  try {
    await f.act.letterMode(f.hook(SID), '/tmp/claude-7.sock', 'x', 'm-1');
    await writeFile(join(f.markers, OTHER), OTHER); await writeFile(join(f.markers, 'claude-8.sock'), OTHER);
    await f.act.sessionStart(f.hook(SID, { source: 'startup' }), '/tmp/claude-8.sock');
    assert.deepEqual(f.names(), [SID, OTHER, 'claude-7.sock'].sort());
    await f.act.sessionStart(f.hook(SID, { source: 'compact' }), '/tmp/claude-7.sock');
    assert.deepEqual(f.names(), [SID, OTHER, 'claude-7.sock'].sort());
    await writeFile(join(f.markers, 'claude-5.sock'), SID);
    await f.act.sessionEnd(f.hook(SID, { reason: 'other' }));
    assert.deepEqual(f.names(), [SID, OTHER].sort(), 'the id marker stays for a process that resumes the turn');
    assert.equal(await readFile(join(f.markers, SID), 'utf8'), SID);
  } finally { await f.close(); }
});

// Claude runs no hook after No (without a note) or Esc, so a letter is judged by the
// prompt_id of its own UserPromptSubmit. Its own Stop ends it, unless background work is left; a Stop or StopFailure of another
// turn while it never had its own end signal means its turn was cut short.
const BUSY = [{ id: 'b1', type: 'shell', status: 'running', command: 'npm test' }];
type Fixture = Awaited<ReturnType<typeof fixture>>;
const letter = (f: Fixture, messageId: string, promptId: unknown, sessionId = SID) =>
  f.act.letterMode(f.hook(sessionId, promptId === undefined ? {} : { prompt_id: promptId }), `/tmp/${sessionId}.sock`, 'x', messageId);
const stop = (f: Fixture, promptId: unknown, background: unknown = [], sessionId = SID) =>
  f.act.turnEnded(f.hook(sessionId, { hook_event_name: 'Stop', prompt_id: promptId, background_tasks: background }));
const failure = (f: Fixture, promptId: unknown) =>
  f.act.turnEnded(f.hook(SID, { hook_event_name: 'StopFailure', prompt_id: promptId, error: 'server_error' }));
const settled = (letters: readonly string[], reason: ReceiptReason, sessionId = SID) => ({ sessionId, letters, reason });

test('a letter settles once at its own Stop as ended; Claude\'s own housekeeping tasks do not hold it', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(MAINTENANCE_TASKS, ['dream', 'auto-mode scan', 'memory import']);
    assert.equal(await letter(f, 'm-1', 'p1'), 'act');
    stop(f, 'p1', MAINTENANCE_TASKS.map(type => ({ id: type, type, status: 'running' })));
    assert.deepEqual(f.settled, [settled(['m-1'], 'ended')]);
    stop(f, 'p1'); stop(f, 'p2'); failure(f, 'p3'); await f.act.sessionEnd(f.hook(SID));
    assert.equal(f.settled.length, 1);
  } finally { await f.close(); }
});

test('a letter whose own Stop leaves background work waits; the next clean Stop of any turn ends it, never as interrupted', async () => {
  const f = await fixture();
  try {
    await letter(f, 'm-1', 'p1');
    for (const background of [BUSY, null, 'none', [null], [{ id: 'x' }]]) stop(f, 'p1', background);
    stop(f, 'p2', BUSY);
    assert.deepEqual(f.settled, []);
    stop(f, 'p3');
    assert.deepEqual(f.settled, [settled(['m-1'], 'ended')]);
  } finally { await f.close(); }
});

test('a letter whose turn never had its own Stop is interrupted at a later turn\'s Stop or StopFailure (No or Esc)', async () => {
  for (const end of [(f: Fixture) => stop(f, 'p2'), (f: Fixture) => failure(f, 'p2'), (f: Fixture) => stop(f, 'p2', BUSY)]) {
    const f = await fixture();
    try {
      await letter(f, 'm-1', 'p1');
      end(f);
      assert.deepEqual(f.settled, [settled(['m-1'], 'interrupted')]);
    } finally { await f.close(); }
  }
});

test('StopFailure fails the letters of its own turn and leaves the ones still waiting on background work', async () => {
  const f = await fixture();
  try {
    await letter(f, 'm-1', 'p1');
    stop(f, 'p1', BUSY);
    await letter(f, 'm-2', 'p2');
    failure(f, 'p2');
    assert.deepEqual(f.settled, [settled(['m-2'], 'failed')]);
    stop(f, 'p3');
    assert.deepEqual(f.settled.at(-1), settled(['m-1'], 'ended'));
  } finally { await f.close(); }
});

test('one end signal settles several letters, one call per reason in the order the letters came', async () => {
  const f = await fixture();
  try {
    await letter(f, 'm-1', 'p1'); await letter(f, 'm-2', 'p2'); await letter(f, 'm-3', 'p2');
    stop(f, 'p2');
    assert.deepEqual(f.settled, [settled(['m-1'], 'interrupted'), settled(['m-2', 'm-3'], 'ended')]);
  } finally { await f.close(); }
});

test('SessionEnd closes every open letter, waiting ones included, and nothing is left for a later Stop', async () => {
  const f = await fixture();
  try {
    await letter(f, 'm-1', 'p1'); stop(f, 'p1', BUSY); await letter(f, 'm-2', 'p2');
    await f.act.sessionEnd(f.hook(SID, { reason: 'prompt_input_exit' }));
    assert.deepEqual(f.settled, [settled(['m-1', 'm-2'], 'closed')]);
    stop(f, 'p3');
    assert.equal(f.settled.length, 1);
  } finally { await f.close(); }
});

test('only the signalling session settles; a prompt_id that is not a string, on a letter or a signal, settles nothing', async () => {
  const f = await fixture();
  try {
    await letter(f, 'm-1', 'p1'); await letter(f, 'm-2', 'p1', OTHER);
    stop(f, 'p1', [], OTHER);
    assert.deepEqual(f.settled, [settled(['m-2'], 'ended', OTHER)]);
    for (const promptId of [undefined, 7, null]) stop(f, promptId);
    f.act.turnEnded(f.hook(SID, { hook_event_name: 'Notification', prompt_id: 'p9', notification_type: 'idle_prompt' }));
    assert.equal(f.settled.length, 1);
    for (const promptId of [undefined, 7, '']) assert.equal(await letter(f, `m-${String(promptId)}`, promptId), 'act', 'act gating is unchanged');
    stop(f, 'p9');
    assert.deepEqual(f.settled.at(-1), settled(['m-1'], 'interrupted'));
    assert.equal(f.settled.length, 2);
  } finally { await f.close(); }
});

test('a letter handled as direct is never tracked', async () => {
  const f = await fixture();
  try {
    assert.equal(await f.act.letterMode(f.hook(SID, { prompt_id: 'p1', permission_mode: 'dontAsk' }), '/tmp/c.sock', 'x', 'm-1'), 'direct');
    assert.equal(await f.act.letterMode(f.hook(SID, { prompt_id: 'p1' }), null, 'x', 'm-2'), 'direct');
    stop(f, 'p2'); await f.act.sessionEnd(f.hook(SID));
    assert.deepEqual(f.settled, []);
  } finally { await f.close(); }
});
