// INPUT: Authenticated process generations and deferred lifecycle callbacks.
// OUTPUT: Admission capability and fail-closed race regression checks.
// POS: Pure App admission contract tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppAdmission } from '../../src/bridge/app-admission.ts';
const sid = '12345678-1234-4234-8234-123456789abc';
const identity = Object.freeze({ pid: 123, uid: 501, pidVersion: 1, uniqueId: '123' });
function setup(verify = async () => {}, activate = async (opaque: object) => opaque) {
  const opaque = {};
  const gate = new AppAdmission({ runId: sid,
    verifyCandidate: verify, activateCandidate: activate, assertOpen() {}, onRevoke() {} });
  const candidate = gate.observeStart({ nativeSessionId: sid, cliGeneration: identity, appGeneration: identity, candidateOpaque: opaque });
  const confirmation = { schemaVersion: 1, action: 'activate-app', runId: sid,
    candidateId: candidate.candidateId, source: 'app-status-copy-all', nativeSessionId: sid,
    desktopSessionId: `local_${sid}`, identityFingerprint: candidate.identityFingerprint, statusReportSha256: 'a'.repeat(64) };
  return { gate, opaque, candidate, confirmation };
}
test('pending view is frozen data and original opaque alone activates', async () => {
  const { gate, opaque, candidate, confirmation } = setup();
  assert.throws(() => gate.assertActive());
  assert.equal(Object.isFrozen(candidate), true);
  assert.equal(Object.hasOwn(candidate, 'candidateOpaque'), false);
  assert.equal(await gate.whenCandidate, candidate);
  assert.equal(await gate.activate(candidate.candidateId, confirmation), opaque);
  assert.equal(gate.assertActive(), opaque);
});
test('every second authenticated Start permanently closes admission', () => {
  const { gate } = setup();
  assert.throws(() => gate.observeStart({ nativeSessionId: sid, cliGeneration: { ...identity, uniqueId: '456' }, appGeneration: identity, candidateOpaque: {} }));
  assert.equal(gate.state, 'revoked');
});
test('confirmation rejects extra keys, symbols, accessors and mismatches without invoking getters', async () => {
  for (const change of [
    (value: any) => ({ ...value, extra: true }),
    (value: any) => ({ ...value, [Symbol()]: true }),
    (value: any) => ({ ...value, desktopSessionId: 'bad' }),
    (value: any) => Object.defineProperty({ ...value }, 'action', { get() { throw new Error('getter'); } }),
  ]) {
    const { gate, candidate, confirmation } = setup();
    await assert.rejects(gate.activate(candidate.candidateId, change(confirmation)), /APP_ADMISSION/);
    assert.equal(gate.state, 'revoked');
  }
});
test('invalidation during either await never resurrects candidate', async () => {
  for (const phase of ['verify', 'activate']) {
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const { gate, candidate, confirmation } = setup(
      phase === 'verify' ? () => hold : async () => {},
      phase === 'activate' ? async opaque => { await hold; return opaque; } : async opaque => opaque);
    const result = gate.activate(candidate.candidateId, confirmation);
    await Promise.resolve();
    gate.invalidate(); release();
    await assert.rejects(result);
    assert.equal(gate.state, 'revoked');
    assert.throws(() => gate.assertActive());
  }
});
test('concurrent and repeated activation revoke the run', async () => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const { gate, candidate, confirmation } = setup(() => hold);
  const first = gate.activate(candidate.candidateId, confirmation);
  await assert.rejects(gate.activate(candidate.candidateId, confirmation));
  release(); await assert.rejects(first);
  const other = setup();
  await other.gate.activate(other.candidate.candidateId, other.confirmation);
  await assert.rejects(other.gate.activate(other.candidate.candidateId, other.confirmation));
});
test('second authenticated Start rejects every identity and SID combination', () => {
  for (const cliGeneration of [identity, { ...identity, uniqueId: '456' }]) {
    for (const nativeSessionId of [sid, '87654321-4321-4321-8321-abcdef123456']) {
      const { gate } = setup();
      assert.throws(() => gate.observeStart({ nativeSessionId, cliGeneration, appGeneration: identity, candidateOpaque: {} }));
      assert.equal(gate.state, 'revoked');
    }
  }
});
test('callback errors revoke and waiting rejection has an immediate observer', async () => {
  const gate = new AppAdmission({ runId: sid, verifyCandidate: async () => {},
    activateCandidate: async () => ({}), assertOpen() {}, onRevoke() {} });
  gate.invalidate();
  await assert.rejects(gate.whenCandidate);
  for (const phase of ['verify', 'activate']) {
    const fail = async () => { throw new Error('callback failed'); };
    const item = setup(phase === 'verify' ? fail : async () => {}, phase === 'activate' ? fail : async opaque => opaque);
    await assert.rejects(item.gate.activate(item.candidate.candidateId, item.confirmation), /callback failed/);
    assert.equal(item.gate.state, 'revoked');
  }
});
test('confirmation identifiers, fingerprints and hashes are exact canonical data', async () => {
  for (const field of ['runId', 'candidateId', 'nativeSessionId', 'desktopSessionId', 'identityFingerprint', 'statusReportSha256']) {
    const { gate, candidate, confirmation } = setup();
    await assert.rejects(gate.activate(candidate.candidateId, { ...confirmation, [field]: 'invalid' }));
    assert.equal(gate.state, 'revoked');
  }
});

test('native UUID cannot impersonate the independent desktop ID', async () => {
  const { gate, candidate, confirmation } = setup();
  await assert.rejects(gate.activate(candidate.candidateId, { ...confirmation, desktopSessionId: sid }));
});
test('confirmation must be an enumerable plain data record', async () => {
  for (const transform of [
    (value: object) => Object.assign(Object.create({ inherited: true }), value),
    (value: object) => Object.defineProperty({ ...value }, 'action', { value: 'activate-app', enumerable: false }),
  ]) {
    const { gate, candidate, confirmation } = setup();
    await assert.rejects(gate.activate(candidate.candidateId, transform(confirmation)));
  }
});
