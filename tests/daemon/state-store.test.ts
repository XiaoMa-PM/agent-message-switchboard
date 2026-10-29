// INPUT: Temporary private state directories and switchboard-shaped records.
// OUTPUT: File persistence permissions, roundtrip, torn-append tolerance and refusal regressions.
// POS: Offline msd persistence tests; bodies are never part of the stored records.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStateStore, type ContactRecord, type LinkRecord, type MessageRecord } from '../../src/daemon/state-store.ts';
import { createSwitchboard } from '../../src/daemon/switchboard.ts';

const contact: ContactRecord = { harness: 'dsh', sessionId: 'D1', clientSurface: 'desktop', title: '评审', cwd: '/w', project: '/w',
  alias: null, registeredAt: '2026-10-20T00:00:00.000Z', lastSeenAt: '2026-10-20T00:00:00.000Z', binding: null };
const link: LinkRecord = { linkId: 'L1', a: { harness: 'claude-code', sessionId: 'C1' }, b: { harness: 'dsh', sessionId: 'D1' },
  createdAt: '2026-10-20T00:00:00.000Z', paused: false, sequences: { x: 1 } };
const message: MessageRecord = { messageId: 'm1', linkId: 'L1', from: link.a, to: link.b, sentAt: '2026-10-20T00:00:00.000Z',
  state: 'pending', transport: null, sequence: 1, bytes: 3, inReplyTo: null, bodySha256: 'a'.repeat(64) };
const directory = () => join(mkdtempSync(join(tmpdir(), 'msd-state-')), 'state');

test('directory and message metadata persist as private files and load back with last-write-wins', () => {
  const dir = directory(); const store = createStateStore(dir);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.deepEqual(store.load(), { contacts: [], links: [], messages: [] });
  store.saveDirectory([contact], [link]);
  store.appendMessage(message); store.appendMessage({ ...message, state: 'dispatched' });
  assert.equal(statSync(join(dir, 'directory.json')).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, 'messages.jsonl')).mode & 0o777, 0o600);
  const loaded = createStateStore(dir).load();
  assert.deepEqual([loaded.contacts, loaded.links, loaded.messages.map(item => item.state)], [[contact], [link], ['dispatched']]);
  appendFileSync(join(dir, 'messages.jsonl'), '{"messageId":"torn"');
  assert.equal(createStateStore(dir).load().messages.length, 1);
});

test('a switchboard on file state survives a restart without writing bodies to disk', async () => {
  const dir = directory();
  const first = createSwitchboard({ store: createStateStore(dir) });
  const push = async () => ({ state: 'dispatched', transport: null } as const);
  const claude = first.register({ harness: 'claude-code', sessionId: 'C1', clientSurface: 'cli', title: null, cwd: null, project: null,
    push, verify: async () => {}, notice: async () => {} });
  first.register({ harness: 'dsh', sessionId: 'D1', clientSurface: 'desktop', title: null, cwd: null, project: null, push, verify: async () => {}, notice: async () => {} });
  await first.send({ harness: 'claude-code', sessionId: 'C1', generation: claude.generation }, { harness: 'dsh', target: 'D1', body: 'PRIVATE-TEXT' });
  const disk = readFileSync(join(dir, 'directory.json'), 'utf8') + readFileSync(join(dir, 'messages.jsonl'), 'utf8');
  assert.equal(disk.includes('PRIVATE-TEXT'), false);
  const second = createSwitchboard({ store: createStateStore(dir) });
  assert.deepEqual([second.list({}).length, second.links().length, second.messages({}).length], [2, 1, 1]);
});

test('corrupt directory state or loose permissions refuse to load instead of silently resetting', () => {
  const dir = directory(); const store = createStateStore(dir);
  store.saveDirectory([contact], [link]);
  writeFileSync(join(dir, 'directory.json'), '{"schemaVersion":1,"contacts":[{}],"links":[]}', { mode: 0o600 });
  assert.throws(() => store.load(), /STATE_UNREADABLE/);
  writeFileSync(join(dir, 'directory.json'), 'not json', { mode: 0o600 });
  assert.throws(() => store.load(), /STATE_UNREADABLE/);
  store.saveDirectory([contact], [link]); chmodSync(join(dir, 'directory.json'), 0o644);
  assert.throws(() => store.load(), /STATE_UNREADABLE/);
  chmodSync(dir, 0o755);
  assert.throws(() => createStateStore(dir), /STATE_UNREADABLE/);
});

test('messages.jsonl tolerates only a torn final line; any complete invalid line refuses to load', () => {
  const line = (record: MessageRecord) => JSON.stringify(record) + '\n';
  const second = { ...message, messageId: 'm2' };
  const cases: Array<[string, string, RegExp | null]> = [
    ['corrupt middle line', line(message) + '{"messageId":"broken"\n' + line(second), /STATE_UNREADABLE/],
    ['blank middle line', line(message) + '\n' + line(second), /STATE_UNREADABLE/],
    ['complete but invalid last line', line(message) + '{"messageId":"m3"}\n', /STATE_UNREADABLE/],
    ['torn last line', line(message) + line(second) + '{"messageId":"m3","linkId"', null],
  ];
  for (const [name, content, error] of cases) {
    const dir = directory(); createStateStore(dir);
    writeFileSync(join(dir, 'messages.jsonl'), content, { mode: 0o600 });
    if (error) assert.throws(() => createStateStore(dir).load(), error, name);
    else assert.deepEqual(createStateStore(dir).load().messages.map(item => item.messageId), ['m1', 'm2'], name);
  }
});

test('a tolerated torn tail is cut before the next append so the following start still loads', () => {
  const dir = directory(); const store = createStateStore(dir);
  store.appendMessage(message);
  appendFileSync(join(dir, 'messages.jsonl'), '{"messageId":"torn"');
  const reopened = createStateStore(dir);
  assert.deepEqual(reopened.load().messages.map(item => item.messageId), ['m1']);
  reopened.appendMessage({ ...message, messageId: 'm2' });
  assert.equal(readFileSync(join(dir, 'messages.jsonl'), 'utf8').includes('torn'), false);
  assert.deepEqual(createStateStore(dir).load().messages.map(item => item.messageId), ['m1', 'm2']);
});
