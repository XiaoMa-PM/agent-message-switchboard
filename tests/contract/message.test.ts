// INPUT: Synthetic v1 endpoint/request/frame values and deliberate corruptions.
// OUTPUT: Contract validation and immutable metadata assertions.
// POS: Offline boundary tests for the first protocol version.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEndpoint, parseSend, parseReply, parseEnvelope, parsePushOutcome } from '../../src/protocol/message.ts';
import { endpoint } from '../helpers/session.ts';

const send = { schemaVersion: 1, messageId: 'm', linkId: 'l', body: ' 正文 👋\n' };

test('v1 endpoint snapshot is immutable and keeps opaque native IDs', () => {
  const input = { ...endpoint('a') };
  const value = parseEndpoint(input);
  input.endpointId = 'changed';
  assert.equal(value.endpointId, 'a');
  assert.ok(Object.isFrozen(value));
});

test('rejects unknown schema versions and invalid endpoint fields', () => {
  assert.throws(() => parseEndpoint({ ...endpoint('a'), schemaVersion: 2 }), /UNSUPPORTED_SCHEMA/);
  for (const raw of [null, [], { ...endpoint('a'), harness: 'unknown' },
    { ...endpoint('a'), routeGeneration: '' }, { ...endpoint('a'), extra: true }]) {
    assert.throws(() => parseEndpoint(raw), /INVALID_/);
  }
});

test('send and reply keep body unchanged and reject caller identity overrides', () => {
  assert.equal(parseSend(send).body, send.body);
  assert.equal(parseReply({ schemaVersion: 1, messageId: 'r', inReplyTo: 'm', body: send.body }).body, send.body);
  for (const key of ['sender', 'recipient', 'replyTo', 'authority']) {
    assert.throws(() => parseSend({ ...send, [key]: 'forged' }), /INVALID_/);
  }
  assert.throws(() => parseSend({ ...send, body: 1 }), /INVALID_/);
  assert.throws(() => parseReply({ schemaVersion: 1, messageId: '', inReplyTo: 'm', body: '' }), /INVALID_/);
});

test('wire frame validates version, sequence, time, and peer authority', () => {
  const frame = { ...send, sender: endpoint('a'), recipient: endpoint('b', 'claude-code'),
    replyTo: endpoint('a'), inReplyTo: null, sequence: 1,
    sentAt: '2026-01-01T00:00:00.000Z', source: 'peer', authority: 'none' };
  assert.deepEqual(parseEnvelope(JSON.parse(JSON.stringify(frame))), frame);
  for (const patch of [{ sequence: 0 }, { sentAt: 'bad' }, { authority: 'user' },
    { source: 'user' }, { body: null }, { unexpected: true },
    { replyTo: endpoint('c') }, { recipient: endpoint('b') }]) {
    assert.throws(() => parseEnvelope({ ...frame, ...patch }), /INVALID_/);
  }
});

test('push outcomes distinguish written evidence from confirmed dispatch', () => {
  const raw = { state: 'delivery-unknown', transport: 'written' };
  const outcome = parsePushOutcome(raw);
  raw.transport = 'changed';
  assert.deepEqual(outcome, { state: 'delivery-unknown', transport: 'written' });
  assert.ok(Object.isFrozen(outcome));
  assert.deepEqual(parsePushOutcome({ state: 'dispatched', transport: null }), { state: 'dispatched', transport: null });
  for (const invalid of [null, [], {}, { state: 'dispatched' },
    { state: 'dispatched', transport: 'written' }, { state: 'read', transport: null },
    { state: 'delivery-unknown', transport: 'accepted' }, { state: 'delivery-unknown', transport: null, token: 'fake' }]) {
    assert.throws(() => parsePushOutcome(invalid), /INVALID_PUSH_OUTCOME/);
  }
});
