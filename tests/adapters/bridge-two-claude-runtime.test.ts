// INPUT: Two synthetic CLI kernel/helper identities, explicit SID/socket routes and one original DSH actor.
// OUTPUT: Shared-runtime six-message isolation, authenticated Skill correlation and independent revocation regressions.
// POS: Offline integration fixtures; no actual kernel, socket, host, model or hot-switch acceptance proof.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSessionRuntime } from '../../src/bridge/session-runtime.ts';
import { createSessionDirectory } from '../../src/registry/session-directory.ts';
import { type ProcessSnapshot } from '../../src/adapters/claude/peer-identity.ts';
import { type EpochBinding } from '../../src/adapters/claude/session-epoch.ts';
import { type StdioRequest } from '../../src/bridge/stdio-rpc.ts';
import { parseEnvelope, type Endpoint, type Envelope } from '../../src/protocol/message.ts';

const pin = { path: '/synthetic/2.1.295', sha256: 'a'.repeat(64) };
function target(index: number) {
  const cli: ProcessSnapshot = { pid: 77 + index, uid: 501, pidVersion: 12 + index,
    uniqueId: String(777 + index), parentPid: 1, parentUniqueId: '1', exe: pin.path, sha256: pin.sha256 };
  const helper: ProcessSnapshot = { ...cli, pid: 99 + index, pidVersion: 22 + index,
    uniqueId: String(999 + index), parentPid: cli.pid, parentUniqueId: cli.uniqueId, exe: '/synthetic/python' };
  return { sid: `00000000-0000-0000-0000-00000000000${index + 1}`, cli, helper,
    socket: `/synthetic/native-${index}/inbox.sock`, namespace: (index ? 'd' : 'c').repeat(64) };
}
type Target = ReturnType<typeof target>;
function request(peer: Target, payload: unknown): StdioRequest {
  return { schemaVersion: 1, requestId: '00000000-0000-0000-0000-000000000099',
    peer: { pid: peer.helper.pid, uid: peer.helper.uid, pidVersion: peer.helper.pidVersion },
    snapshots: [[peer.helper], [peer.helper]], payload };
}
function lifecycle(peer: Target, event = 'SessionStart', extra = {}) {
  return { hook_event_name: event, session_id: peer.sid, transcript_path: '/synthetic/transcript',
    cwd: '/synthetic/shared-project', permission_mode: 'default',
    ...(event === 'SessionStart' ? { source: 'startup' } : { reason: 'prompt_input_exit' }), ...extra };
}
function skill(peer: Target, event: string, args: object, callId: string, extra = {}) {
  return { hook_event_name: event, session_id: peer.sid, transcript_path: '/synthetic/transcript',
    cwd: '/synthetic/shared-project', tool_name: 'Skill', tool_use_id: callId,
    tool_input: { skill: 'agent-message-switchboard:message', args: JSON.stringify(args) },
    ...(event === 'PostToolUse' ? { tool_response: { success: true, commandName: 'agent-message-switchboard:message' } } : {}), ...extra };
}
function fixture() {
  const targets = [target(0), target(1)]; const [a, b] = targets;
  const actor = { id: 'original-dsh', ctx: {}, session: { header: { id: 'original-dsh', cwd: '/synthetic/dsh-creation' } } };
  const processes = new Map(targets.flatMap(peer => [peer.cli, peer.helper]).map(row => [row.pid, row]));
  const bindings = new Map<string, EpochBinding>(); const routeCalls: { pid: number; sid: string }[] = [];
  const deliveries: { socket: string | null; frame: Envelope }[] = [];
  const runtime = createSessionRuntime({ host: { surface: 'desktop', version: '0.2.0-rc.2',
    storageNamespace: 'b'.repeat(64), hostInstanceId: 'fixed-host', routeGeneration: 'fixed-generation',
    getAgent: id => id === actor.id ? actor : undefined, isArchived: () => false },
    inspect: async pid => processes.get(pid) ?? null,
    classify: row => row.exe === pin.path ? 'cli' : row.exe === '/synthetic/python' ? 'wrapper' : 'unsupported',
    cliPin: pin, assertOpen() {}, guardDispatch() {},
    async getRoute(identity, sid) {
      routeCalls.push({ pid: identity.pid, sid });
      const peer = targets.find(peer => peer.sid === sid && peer.cli.pid === identity.pid);
      assert.ok(peer, 'route must match both the resolved CLI and its explicit SID');
      return { schemaVersion: 1, ownerPid: identity.pid, ownerStart: `start-${identity.uniqueId}`, socket: peer.socket,
        endpoint: { schemaVersion: 1, endpointId: `claude:${sid}`, harness: 'claude-code', nativeSessionId: sid,
          storageNamespace: peer.namespace, hostInstanceId: `claude-pid:${identity.pid}`, routeGeneration: `route-${sid}` } };
    },
    makeDshPush: () => frame => { deliveries.push({ socket: null, frame }); return { state: 'dispatched', transport: null }; },
    makeClaudePush: binding => {
      bindings.set(binding.nativeSessionId, binding);
      const socket = binding.route.socket;
      return frame => { deliveries.push({ socket, frame }); return { state: 'delivery-unknown', transport: 'written' }; };
    } });
  const source = runtime.registerDsh({ agent: actor });
  const handle = (peer: Target, payload: unknown) => runtime.handle(request(peer, payload));
  const call = async (peer: Target, args: object, callId: string) => {
    await handle(peer, skill(peer, 'PreToolUse', args, callId));
    return handle(peer, skill(peer, 'PostToolUse', args, callId));
  };
  return { runtime, source, actor, targets, a, b, bindings, routeCalls, deliveries, handle, call };
}
type Fixture = ReturnType<typeof fixture>;
async function startBoth(f: Fixture) {
  for (const peer of f.targets) assert.deepEqual(await f.handle(peer, lifecycle(peer)), { prepared: true });
}
function envelope(frame: Envelope, sender: Endpoint, recipient: Endpoint, linkId: string,
  messageId: string, body: string, sequence = 1, inReplyTo: string | null = null) {
  assert.deepEqual(parseEnvelope(frame), frame);
  assert.deepEqual(frame, { schemaVersion: 1, messageId, linkId, sender, recipient, replyTo: sender,
    inReplyTo, body, sequence, sentAt: frame.sentAt, source: 'peer', authority: 'none' });
}
function peerEndpoint(f: Fixture, peer: Target) {
  const binding = f.bindings.get(peer.sid)!;
  assert.match(binding.endpoint.endpointId, /^claude-epoch:[a-f0-9-]{36}$/);
  assert.deepEqual(binding.endpoint, { schemaVersion: 1, endpointId: `claude-epoch:${binding.epoch}`,
    harness: 'claude-code', nativeSessionId: peer.sid, storageNamespace: peer.namespace,
    hostInstanceId: `claude-pid:${peer.cli.pid}`, routeGeneration: `route-${peer.sid}` });
  assert.equal(binding.identity.pid, peer.cli.pid); assert.equal(binding.identity.uniqueId, peer.cli.uniqueId);
  assert.equal(binding.route.socket, peer.socket); return binding.endpoint;
}
const connect = (id: string) => ({ schemaVersion: 1, operation: 'connect', targetSessionId: id });
const reply = (id: string, messageId: string, body = messageId) =>
  ({ schemaVersion: 1, operation: 'reply', inReplyTo: id, messageId, body });
const send = (linkId: string, messageId: string, body = messageId) => ({ schemaVersion: 1, linkId, messageId, body });

test('two independent CLI identities register distinct SID/socket endpoints even with the same creation cwd', async () => {
  const f = fixture(); await startBoth(f);
  const descriptors = await f.runtime.describe('claude-code');
  assert.deepEqual(descriptors, f.targets.map(peer => ({ endpoint: peerEndpoint(f, peer), cwd: '/synthetic/shared-project' })));
  assert.equal(new Set(descriptors.map(row => row.endpoint.endpointId)).size, 2);
  assert.deepEqual(f.routeCalls, f.targets.map(peer => ({ pid: peer.cli.pid, sid: peer.sid })));
  assert.ok(Object.isFrozen(descriptors)); assert.ok(descriptors.every(Object.isFrozen));
  assert.equal(f.deliveries.length, 0); f.runtime.close();
});

test('one DSH actor completes A1/B1 then original-address A2 with six exact isolated envelopes', async () => {
  const f = fixture(); await startBoth(f);
  const a = peerEndpoint(f, f.a); const b = peerEndpoint(f, f.b); const dsh = f.source.endpoint;
  const linkA = await f.source.connect(f.a.sid); const linkB = await f.source.connect(f.b.sid);
  assert.notEqual(linkA, linkB);
  for (const [peer, link] of [[f.a, linkA], [f.b, linkB]] as const) {
    assert.deepEqual(await f.call(peer, connect(f.actor.id), 'connect'), { linkId: link, targetSessionId: f.actor.id });
  }
  await f.source.send(send(linkA, 'a-c1', 'RUN|A-DSH-C1\n😀'));
  await f.source.send(send(linkB, 'b-c1', 'RUN|B-DSH-C1'));
  const ar = await f.call(f.a, reply('a-c1', 'a-r1', 'RUN|A-CLI-R1'), 'reply-1');
  const br = await f.call(f.b, reply('b-c1', 'b-r1', 'RUN|B-CLI-R1'), 'reply-1');
  assert.ok('receipt' in ar); assert.ok('receipt' in br);
  assert.deepEqual(ar.receipt, { messageId: 'a-r1', state: 'dispatched', transport: null,
    sequence: 1, linkId: linkA, targetSessionId: f.actor.id });
  assert.deepEqual(br.receipt, { messageId: 'b-r1', state: 'dispatched', transport: null,
    sequence: 1, linkId: linkB, targetSessionId: f.actor.id });
  const originalReply = f.deliveries[2].frame;
  await f.source.reply({ schemaVersion: 1, messageId: 'a-c2', inReplyTo: originalReply.messageId, body: 'RUN|A-DSH-C2' });
  const ar2 = await f.call(f.a, reply('a-c2', 'a-r2', 'RUN|A-CLI-R2'), 'reply-2');
  assert.ok('receipt' in ar2); assert.equal(ar2.receipt.sequence, 2); assert.equal(ar2.receipt.linkId, linkA);
  assert.equal(f.deliveries.length, 6);
  assert.deepEqual(f.deliveries.map(row => row.socket), [f.a.socket, f.b.socket, null, null, f.a.socket, null]);
  const frames = f.deliveries.map(row => row.frame);
  envelope(frames[0], dsh, a, linkA, 'a-c1', 'RUN|A-DSH-C1\n😀');
  envelope(frames[1], dsh, b, linkB, 'b-c1', 'RUN|B-DSH-C1');
  envelope(frames[2], a, dsh, linkA, 'a-r1', 'RUN|A-CLI-R1', 1, 'a-c1');
  envelope(frames[3], b, dsh, linkB, 'b-r1', 'RUN|B-CLI-R1', 1, 'b-c1');
  envelope(frames[4], dsh, a, linkA, 'a-c2', 'RUN|A-DSH-C2', 2, 'a-r1');
  envelope(frames[5], a, dsh, linkA, 'a-r2', 'RUN|A-CLI-R2', 2, 'a-c2');
  assert.equal(f.routeCalls.length, 2); f.runtime.close();
});

test('B Post cannot consume A Pre under an identical callId or a forged A session_id', async () => {
  const f = fixture(); await startBoth(f); const args = connect(f.actor.id);
  await f.handle(f.a, skill(f.a, 'PreToolUse', args, 'same-call'));
  await assert.rejects(f.handle(f.b, skill(f.b, 'PostToolUse', args, 'same-call')), /SKILL_PRE_MISSING/);
  await assert.rejects(f.handle(f.b, skill(f.b, 'PostToolUse', args, 'same-call', { session_id: f.a.sid })), /SKILL_SOURCE_MISMATCH/);
  const ar = await f.handle(f.a, skill(f.a, 'PostToolUse', args, 'same-call'));
  const br = await f.call(f.b, args, 'same-call');
  assert.ok('linkId' in ar); assert.ok('linkId' in br); assert.notEqual(ar.linkId, br.linkId);
  assert.equal(ar.linkId, await f.source.connect(f.a.sid)); assert.equal(br.linkId, await f.source.connect(f.b.sid));
  assert.equal(f.deliveries.length, 0); f.runtime.close();
});

test('B cannot reply to an A recipient frame and the legitimate A reply remains available', async () => {
  const f = fixture(); await startBoth(f); const link = await f.source.connect(f.a.sid);
  await f.source.send(send(link, 'only-a'));
  await assert.rejects(f.call(f.b, reply('only-a', 'forged-b'), 'bad-reply'), /CLAUDE_CHANNEL_DELIVERY_UNKNOWN/);
  assert.equal(f.deliveries.length, 1);
  const response = await f.call(f.a, reply('only-a', 'real-a'), 'good-reply'); assert.ok('receipt' in response);
  assert.equal(response.receipt.sequence, 1); assert.equal(f.deliveries.length, 2);
  envelope(f.deliveries[1].frame, peerEndpoint(f, f.a), f.source.endpoint, link, 'real-a', 'real-a', 1, 'only-a');
  f.runtime.close();
});

test('a second process claiming A SID cannot replace A route or acquire a connection', async () => {
  const f = fixture(); await f.handle(f.a, lifecycle(f.a)); const original = peerEndpoint(f, f.a);
  await assert.rejects(f.handle(f.b, lifecycle(f.b, 'SessionStart', { session_id: f.a.sid })), /DUPLICATE_SESSION/);
  assert.deepEqual(f.routeCalls, [{ pid: f.a.cli.pid, sid: f.a.sid }]);
  await assert.rejects(f.source.connect(f.b.sid), /UNKNOWN_TARGET/);
  await assert.rejects(f.call(f.b, connect(f.actor.id), 'rejected-owner'), /UNREGISTERED_CLAUDE_SESSION/);
  const link = await f.source.connect(f.a.sid); await f.source.send(send(link, 'still-a'));
  assert.equal(f.deliveries[0].socket, f.a.socket);
  envelope(f.deliveries[0].frame, f.source.endpoint, original, link, 'still-a', 'still-a'); f.runtime.close();
});

test('a second SID from the same CLI process revokes A without rebinding or disturbing B', async () => {
  const f = fixture(); await startBoth(f);
  const linkA = await f.source.connect(f.a.sid); const linkB = await f.source.connect(f.b.sid);
  const foreign = '00000000-0000-0000-0000-000000000003';
  await assert.rejects(f.handle(f.a, lifecycle(f.a, 'SessionStart', { session_id: foreign })), /SESSION_EPOCH_REVOKED/);
  assert.equal(f.routeCalls.length, 2); await assert.rejects(f.source.connect(foreign), /UNKNOWN_TARGET/);
  await assert.rejects(f.source.send(send(linkA, 'revoked-a')), /SESSION_EPOCH_REVOKED/);
  await f.source.send(send(linkB, 'intact-b')); assert.equal(f.deliveries.length, 1);
  assert.equal(f.deliveries[0].socket, f.b.socket);
  envelope(f.deliveries[0].frame, f.source.endpoint, peerEndpoint(f, f.b), linkB, 'intact-b', 'intact-b'); f.runtime.close();
});

test('End A rejects replay and whole metadata directory while B existing send and Skill reply survive', async () => {
  const f = fixture(); await startBoth(f);
  const linkA = await f.source.connect(f.a.sid); const linkB = await f.source.connect(f.b.sid);
  const directory = createSessionDirectory({ describe: f.runtime.describe, verifyEndpoint: f.runtime.verifyEndpoint,
    readMetadata: async entry => ({ title: entry.endpoint.nativeSessionId, titleProvider: 'host',
      workspacePath: entry.cwd, cwd: entry.cwd, cwdSource: 'session-creation', worktreePath: null, clientSurface: 'cli' }) });
  assert.equal((await directory.list('claude-code')).length, 2);
  const first = send(linkA, 'before-end-a'); await f.source.send(first);
  await f.handle(f.a, lifecycle(f.a, 'SessionEnd'));
  await assert.rejects(f.source.send(first), /SESSION_EPOCH_REVOKED/);
  await assert.rejects(f.source.send(send(linkA, 'after-end-a')), /SESSION_EPOCH_REVOKED/);
  await assert.rejects(f.call(f.a, reply(first.messageId, 'ended-a-reply'), 'ended-call'), /SESSION_EPOCH_REVOKED/);
  await assert.rejects(f.runtime.describe('claude-code'), /SESSION_EPOCH_REVOKED/);
  await assert.rejects(directory.list('claude-code'), /^Error: METADATA_QUERY_FAILED$/);
  await f.source.send(send(linkB, 'surviving-b'));
  const response = await f.call(f.b, reply('surviving-b', 'b-answer'), 'after-a-end'); assert.ok('receipt' in response);
  assert.equal(response.receipt.sequence, 1); assert.equal(f.deliveries.length, 3);
  assert.equal(f.deliveries[1].socket, f.b.socket);
  envelope(f.deliveries[1].frame, f.source.endpoint, peerEndpoint(f, f.b), linkB, 'surviving-b', 'surviving-b');
  envelope(f.deliveries[2].frame, peerEndpoint(f, f.b), f.source.endpoint, linkB, 'b-answer', 'b-answer', 1, 'surviving-b');
  f.runtime.close();
});

test('End A leaves B original Skill send and DSH original-address reply usable on their existing link', async () => {
  const f = fixture(); await startBoth(f); const connected = await f.call(f.b, connect(f.actor.id), 'connect-before-end');
  assert.ok('linkId' in connected); await f.handle(f.a, lifecycle(f.a, 'SessionEnd'));
  const sent = await f.call(f.b, { operation: 'send', ...send(connected.linkId, 'b-first') }, 'b-send-after-end');
  assert.ok('receipt' in sent); assert.equal(sent.receipt.linkId, connected.linkId);
  const original = f.deliveries[0].frame;
  await f.source.reply({ schemaVersion: 1, messageId: 'dsh-answer', inReplyTo: original.messageId, body: 'original B reply' });
  assert.equal(f.deliveries.length, 2); assert.equal(f.deliveries[1].socket, f.b.socket);
  envelope(original, peerEndpoint(f, f.b), f.source.endpoint, connected.linkId, 'b-first', 'b-first');
  envelope(f.deliveries[1].frame, f.source.endpoint, peerEndpoint(f, f.b), connected.linkId,
    'dsh-answer', 'original B reply', 1, 'b-first'); f.runtime.close();
});

test('trusted registration closure synchronously rejects an End after the last async snapshot', async () => {
  const f = fixture(); await startBoth(f);
  const verify = f.runtime.captureClaudeRegistrationCheck();
  const snapshot = await f.runtime.describe('claude-code'); assert.equal(snapshot.length, 2);
  verify(); await f.handle(f.a, lifecycle(f.a, 'SessionEnd'));
  assert.throws(verify, /SESSION_EPOCH_REVOKED/); f.runtime.close();
});

test('unverified peer self-report cannot invalidate a trusted registration closure', async () => {
  const f = fixture(); await startBoth(f);
  const verify = f.runtime.captureClaudeRegistrationCheck();
  const unknown = { ...f.a, helper: { ...f.a.helper, pid: 9999 } };
  await assert.rejects(f.handle(unknown, lifecycle(f.a, 'SessionEnd')));
  verify(); assert.equal((await f.runtime.describe('claude-code')).length, 2); f.runtime.close();
});

test('authenticated repeated Start invalidates captured original bindings without rebind', async () => {
  const f = fixture(); await startBoth(f);
  const verify = f.runtime.captureClaudeRegistrationCheck();
  await assert.rejects(f.handle(f.a, lifecycle(f.a)), /SESSION_EPOCH_REVOKED/);
  assert.throws(verify, /SESSION_EPOCH_REVOKED/); f.runtime.close();
});

test('trusted closure retains captured bindings and rejects runtime closure', async () => {
  const f = fixture(); await f.handle(f.a, lifecycle(f.a));
  const verify = f.runtime.captureClaudeRegistrationCheck();
  await f.handle(f.b, lifecycle(f.b)); verify();
  f.runtime.close(); assert.throws(verify, /SESSION_RUNTIME_CLOSED/);
  assert.throws(() => f.runtime.captureClaudeRegistrationCheck(), /SESSION_RUNTIME_CLOSED/);
});
