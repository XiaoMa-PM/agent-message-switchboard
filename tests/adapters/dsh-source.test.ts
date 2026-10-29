// INPUT: Synthetic fixed desktop contexts, loaded root agents and forged tool arguments.
// OUTPUT: Sender-binding regressions for live identity, platform and session restrictions.
// POS: Offline DSH source boundary tests; not a real desktop tool execution proof.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDshSourceBinding } from '../../src/adapters/dsh/source.ts';

const root = Object.freeze({ id: 'session-A', session: { header: { id: 'session-A' } } });
const identity = { surface: 'desktop', version: '0.2.0-rc.2', storageNamespace: 'a'.repeat(64),
  hostInstanceId: 'synthetic-host', routeGeneration: 'generation-1' };

function fixture(agent = root) {
  let current: unknown = agent;
  let archived = false;
  const bind = createDshSourceBinding({ ...identity, getAgent: () => current, isArchived: () => archived });
  return { bind, replace: (value: unknown) => { current = value; }, archive: () => { archived = true; } };
}

test('sender is frozen and comes from trusted execution, never model arguments', () => {
  const f = fixture();
  const actual = f.bind({ agent: root, arguments: { sender: 'victim', harness: 'codex' } });
  assert.deepEqual(actual, { schemaVersion: 1, endpointId: JSON.stringify(['dsh', identity.storageNamespace, 'session-A']), harness: 'dsh',
    nativeSessionId: 'session-A', storageNamespace: identity.storageNamespace,
    hostInstanceId: identity.hostInstanceId, routeGeneration: identity.routeGeneration });
  assert.ok(Object.isFrozen(actual));
});

test('missing, foreign or replaced execution objects cannot bind a source', () => {
  const f = fixture();
  for (const input of [null, {}, { agent: { ...root } }, { agent: { id: '' } }]) {
    assert.throws(() => f.bind(input), /INVALID_DSH_SOURCE/);
  }
  f.replace({ ...root });
  assert.throws(() => f.bind({ agent: root }), /INVALID_DSH_SOURCE/);
  f.replace(undefined);
  assert.throws(() => f.bind({ agent: root }), /INVALID_DSH_SOURCE/);
});

test('subagent, archived, mismatched session ID or absent session cannot bind', () => {
  for (const agent of [
    { id: 'session-A', session: { header: { id: 'session-B' } } },
    { id: 'session-A', session: { header: { id: 'session-A', origin: 'subagent' } } },
    { id: 'session-A' },
    { id: 'session-A', session: { header: { id: 'session-A', origin: 'unknown' } } },
  ]) {
    const bind = createDshSourceBinding({ ...identity, getAgent: () => agent, isArchived: () => false });
    assert.throws(() => bind({ agent }), /INVALID_DSH_SOURCE/);
  }
  const f = fixture();
  f.archive();
  assert.throws(() => f.bind({ agent: root }), /INVALID_DSH_SOURCE/);
});

test('Web, a desktop below 0.2.0-rc.2 or a malformed version is rejected; trusted identity is captured immutably', () => {
  for (const unsupported of [{ surface: 'web' }, { version: '0.2.0-rc.1' }, { version: '0.1.9' }, { version: 'v0.2.1' }, { version: '' }]) {
    assert.throws(() => createDshSourceBinding({ ...identity, ...unsupported,
      getAgent: () => root, isArchived: () => false }), /UNSUPPORTED_DSH_HOST/);
  }
  const options = { ...identity, getAgent: () => root, isArchived: () => false };
  const bind = createDshSourceBinding(options);
  options.hostInstanceId = 'other-host';
  assert.equal(bind({ agent: root }).hostInstanceId, identity.hostInstanceId);
});

test('any desktop at or above 0.2.0-rc.2 binds the same sender', () => {
  for (const version of ['0.2.0-rc.2', '0.2.0', '0.2.1-rc.2', '0.3.0', '1.0.0']) {
    const bind = createDshSourceBinding({ ...identity, version, getAgent: () => root, isArchived: () => false });
    assert.equal(bind({ agent: root }).nativeSessionId, 'session-A', version);
  }
});


test('binding creation rejects plaintext paths and non-SHA256 storage namespaces', () => {
  for (const storageNamespace of ['/fixture/profile', 'relative/profile', '', 'synthetic-profile',
    'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), null as unknown as string]) {
    assert.throws(() => createDshSourceBinding({ ...identity, storageNamespace,
      getAgent: () => root, isArchived: () => false }), /INVALID_DSH_NAMESPACE/);
  }
});
