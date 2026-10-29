// INPUT: Synthetic trusted CLI lifecycle events, original route snapshots and late completions.
// OUTPUT: First-start activation and irreversible revocation/identity-reuse regressions.
// POS: Pure session-generation tests; not live native SID or atomic switch guarantees.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClaudeSessionEpochs } from '../../src/adapters/claude/session-epoch.ts';
import { type ProcessIdentity } from '../../src/adapters/claude/peer-identity.ts';
import { type ClaudeRoute } from '../../src/adapters/claude/registration.ts';

const sid = '00000000-0000-0000-0000-000000000001';
const nextSid = '00000000-0000-0000-0000-000000000002';
const identity: ProcessIdentity = { pid: 77, uid: 501, pidVersion: 12, uniqueId: '18446744073709551614' };
const other: ProcessIdentity = { ...identity, pid: 88, pidVersion: 13, uniqueId: '18446744073709551613' };
function route(id = sid, pid = identity.pid): ClaudeRoute {
  return { schemaVersion: 1, socket: '/fixture/native.sock', ownerPid: pid, ownerStart: 'synthetic-start',
    endpoint: { schemaVersion: 1, endpointId: `claude:${id}`, harness: 'claude-code',
      storageNamespace: 'a'.repeat(64), nativeSessionId: id, hostInstanceId: `claude-pid:${pid}`,
      routeGeneration: 'original-registration-generation' } };
}

test('first Start activates exactly one frozen epoch while preserving original native UUID and route', () => {
  const epochs = new ClaudeSessionEpochs();
  const ticket = epochs.begin(identity, sid);
  let binding: ReturnType<ClaudeSessionEpochs['activate']> | undefined;
  const original = route();
  assert.doesNotThrow(() => { binding = epochs.activate(ticket, original); });
  assert.ok(binding);
  assert.equal(epochs.verify(binding, identity), binding);
  assert.equal(binding.nativeSessionId, sid);
  assert.equal(binding.endpoint.nativeSessionId, sid);
  assert.equal(binding.epoch, ticket.epoch);
  assert.notEqual(binding.endpoint.endpointId, original.endpoint.endpointId);
  assert.equal(binding.endpoint.routeGeneration, original.endpoint.routeGeneration);
  assert.deepEqual(binding.route, original);
  for (const item of [ticket, ticket.identity, binding, binding.identity, binding.endpoint,
    binding.route, binding.route.endpoint]) assert.equal(Object.isFrozen(item), true);
  assert.notEqual(binding.route, original);
  assert.notEqual(binding.route.endpoint, original.endpoint);
  assert.notEqual(binding.identity, identity);
});

for (const newSid of [sid, nextSid]) {
  test(`second Start revokes active epoch before registration can succeed or fail: ${newSid}`, () => {
    const epochs = new ClaudeSessionEpochs();
    const ticket = epochs.begin(identity, sid);
    const binding = epochs.activate(ticket, route());
    assert.throws(() => epochs.begin(identity, newSid), /SESSION_EPOCH_REVOKED/);
    assert.throws(() => epochs.verify(binding, identity), /SESSION_EPOCH_REVOKED/);
    assert.throws(() => epochs.activate(ticket, route()), /SESSION_EPOCH_REVOKED/);
    assert.throws(() => epochs.begin(identity, nextSid), /SESSION_EPOCH_REVOKED/);
  });

  test(`second Start defeats late first activation: ${newSid}`, () => {
    const epochs = new ClaudeSessionEpochs();
    const ticket = epochs.begin(identity, sid);
    assert.throws(() => epochs.begin(identity, newSid), /SESSION_EPOCH_REVOKED/);
    assert.throws(() => epochs.activate(ticket, route()), /SESSION_EPOCH_REVOKED/);
  });
}

for (const stage of ['pending', 'active', 'unknown'] as const) {
  test(`End permanently revokes ${stage} identity and is idempotent`, () => {
    const epochs = new ClaudeSessionEpochs();
    const ticket = stage === 'unknown' ? undefined : epochs.begin(identity, sid);
    const binding = stage === 'active' ? epochs.activate(ticket!, route()) : undefined;
    epochs.revoke(identity); epochs.revoke(identity);
    assert.throws(() => epochs.begin(identity, nextSid), /SESSION_EPOCH_REVOKED/);
    if (ticket) assert.throws(() => epochs.activate(ticket, route()), /SESSION_EPOCH_REVOKED/);
    if (binding) assert.throws(() => epochs.verify(binding, identity), /SESSION_EPOCH_REVOKED/);
  });
}

test('activation is one-shot and cloned or foreign tickets cannot activate', () => {
  const epochs = new ClaudeSessionEpochs();
  const ticket = epochs.begin(identity, sid);
  assert.throws(() => epochs.activate({ ...ticket }, route()), /INVALID_EPOCH_TICKET/);
  assert.throws(() => new ClaudeSessionEpochs().activate(ticket, route()), /INVALID_EPOCH_TICKET/);
  const binding = epochs.activate(ticket, route());
  assert.throws(() => epochs.activate(ticket, route()), /INVALID_EPOCH_TICKET/);
  assert.equal(epochs.verify(binding, identity), binding);
});

test('cloned or foreign bindings are not registered capabilities', () => {
  const epochs = new ClaudeSessionEpochs();
  const binding = epochs.activate(epochs.begin(identity, sid), route());
  assert.throws(() => epochs.verify({ ...binding }, identity), /INVALID_EPOCH_BINDING/);
  assert.throws(() => new ClaudeSessionEpochs().verify(binding, identity), /INVALID_EPOCH_BINDING/);
});

for (const changed of [{ ...identity, uniqueId: '2' }, { ...identity, pidVersion: 13 },
  { ...identity, pid: 78 }, { ...identity, uid: 502 }]) {
  test(`verification requires the current OS identity: ${JSON.stringify(changed)}`, () => {
    const epochs = new ClaudeSessionEpochs();
    const binding = epochs.activate(epochs.begin(identity, sid), route());
    assert.throws(() => epochs.verify(binding, changed), /INVALID_EPOCH_IDENTITY/);
  });
}

test('independent CLI with a new SID gets a new opaque endpoint and cannot reuse old bindings', () => {
  const epochs = new ClaudeSessionEpochs();
  const first = epochs.activate(epochs.begin(identity, sid), route());
  const second = epochs.activate(epochs.begin(other, nextSid), route(nextSid, other.pid));
  assert.notEqual(first.endpoint.endpointId, second.endpoint.endpointId);
  assert.notEqual(first.epoch, second.epoch);
  assert.equal(epochs.verify(first, identity), first);
  assert.equal(epochs.verify(second, other), second);
  assert.throws(() => epochs.verify(first, other), /INVALID_EPOCH_IDENTITY/);
});

test('PID reuse with a new unique/version and SID revokes the previous process without rebinding it', () => {
  const epochs = new ClaudeSessionEpochs();
  const previous = epochs.begin(identity, sid);
  const first = epochs.activate(previous, route());
  const reused = { ...other, pid: identity.pid };
  const second = epochs.activate(epochs.begin(reused, nextSid), route(nextSid, reused.pid));
  assert.throws(() => epochs.verify(first, identity), /SESSION_EPOCH_REVOKED/);
  assert.throws(() => epochs.activate(previous, route()), /SESSION_EPOCH_REVOKED/);
  assert.equal(epochs.verify(second, reused), second);
});

test('an old SID cannot be registered by a new independent CLI after revocation', () => {
  const epochs = new ClaudeSessionEpochs();
  epochs.begin(identity, sid); epochs.revoke(identity);
  assert.throws(() => epochs.begin(other, sid), /DUPLICATE_SESSION/);
  assert.throws(() => epochs.begin(other, nextSid), /SESSION_EPOCH_REVOKED/);
});

test('a second Start with malformed SID revokes before SID validation', () => {
  const epochs = new ClaudeSessionEpochs();
  const ticket = epochs.begin(identity, sid);
  assert.throws(() => epochs.begin(identity, 'bad'), /SESSION_EPOCH_REVOKED/);
  assert.throws(() => epochs.activate(ticket, route()), /SESSION_EPOCH_REVOKED/);
});

test('UUID casing cannot resurrect an already reserved native session', () => {
  const epochs = new ClaudeSessionEpochs();
  const letterSid = 'aaaaaaaa-0000-0000-0000-000000000001';
  epochs.begin(identity, letterSid);
  assert.throws(() => epochs.begin(other, letterSid.toUpperCase()), /DUPLICATE_SESSION/);
});

test('End from a reused PID revokes the old binding and prevents late Start of the new process', () => {
  const epochs = new ClaudeSessionEpochs();
  const binding = epochs.activate(epochs.begin(identity, sid), route());
  const reused = { ...other, pid: identity.pid };
  epochs.revoke(reused);
  assert.throws(() => epochs.verify(binding, identity), /SESSION_EPOCH_REVOKED/);
  assert.throws(() => epochs.begin(reused, nextSid), /SESSION_EPOCH_REVOKED/);
});

for (const [name, changed] of [
  ['ownerPid', { ...route(), ownerPid: 88 }],
  ['schema', { ...route(), schemaVersion: 2 }],
  ['relative socket', { ...route(), socket: 'native.sock' }],
  ['empty ownerStart', { ...route(), ownerStart: '' }],
  ['extra field', { ...route(), sender: 'forged' }],
  ['SID', { ...route(), endpoint: { ...route().endpoint, nativeSessionId: nextSid } }],
  ['old endpoint ID', { ...route(), endpoint: { ...route().endpoint, endpointId: 'forged' } }],
  ['harness', { ...route(), endpoint: { ...route().endpoint, harness: 'dsh' } }],
  ['host owner', { ...route(), endpoint: { ...route().endpoint, hostInstanceId: 'claude-pid:88' } }],
  ['empty generation', { ...route(), endpoint: { ...route().endpoint, routeGeneration: '' } }],
] as const) {
  test(`activation rejects original route ${name} mismatch without reactivation`, () => {
    const epochs = new ClaudeSessionEpochs();
    const ticket = epochs.begin(identity, sid);
    assert.throws(() => epochs.activate(ticket, changed as ClaudeRoute), /INVALID_EPOCH_ROUTE/);
    assert.throws(() => epochs.activate(ticket, route()), /SESSION_EPOCH_REVOKED/);
  });
}

test('caller changes after begin/activate cannot rewrite stored identities or original route', () => {
  const epochs = new ClaudeSessionEpochs();
  const mutableIdentity = { ...identity };
  const ticket = epochs.begin(mutableIdentity, sid);
  mutableIdentity.uniqueId = '2';
  const original = structuredClone(route());
  const binding = epochs.activate(ticket, original);
  (original as { socket: string }).socket = '/fixture/replaced.sock';
  (original.endpoint as { routeGeneration: string }).routeGeneration = 'replaced';
  assert.equal(binding.identity.uniqueId, identity.uniqueId);
  assert.equal(binding.route.socket, route().socket);
  assert.equal(binding.route.endpoint.routeGeneration, route().endpoint.routeGeneration);
  assert.equal(epochs.verify(binding, identity), binding);
});

for (const invalid of [{ ...identity, uniqueId: '0' }, { ...identity, uniqueId: '01' },
  { ...identity, uniqueId: '18446744073709551616' }, { ...identity, pidVersion: -1 }, { ...identity, pid: 1 }]) {
  test(`rejects invalid identity before making a ticket: ${JSON.stringify(invalid)}`, () => {
    assert.throws(() => new ClaudeSessionEpochs().begin(invalid, sid), /INVALID_EPOCH_IDENTITY/);
  });
}

test('rejects malformed native session IDs without guessing an address', () => {
  assert.throws(() => new ClaudeSessionEpochs().begin(identity, 'not-a-UUID'), /INVALID_SESSION/);
});
