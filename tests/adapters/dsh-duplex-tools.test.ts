// INPUT: Fixed official SDK, synthetic duplex identities and owned dispatch gates.
// OUTPUT: Three-tool argument, original-context, compact receipt and cancellation tests.
// POS: Offline SDK/Router checks; no native desktop, model, socket or migration proof.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { createScope } from '@deepseek-ai/dsh-scope';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime, type ToolDefinition, type ToolRunContext, type ToolExecutionInput } from '@deepseek-ai/dsh-tools';
import { createDuplex, type DuplexConnection } from '../../src/bridge/duplex.ts';
import { CLAUDE_DELIVERY_NOTES } from '../../src/bridge/claude-channel.ts';
import { type EpochBinding } from '../../src/adapters/claude/session-epoch.ts';
import { type Envelope, type PushOutcome, type Receipt } from '../../src/protocol/message.ts';
import { endpoint } from '../helpers/session.ts';

import { createDshDuplexTools } from '../../src/adapters/dsh/duplex-tools.ts';
type ToolValue = { receipt: Pick<Receipt, 'messageId' | 'state' | 'transport'> &
  { sequence: number; linkId: string; targetSessionId: string }; deliveryNote: string };
const accepted = Object.freeze({ state: 'dispatched', transport: null } as const);

async function fixture(receive: (frame: Envelope) => PushOutcome | Promise<PushOutcome> = () => accepted) {
  const agent: any = { id: 'synthetic-dsh', session: { header: { id: 'synthetic-dsh' } } };
  const claudeEndpoint = endpoint('claude', 'claude-code');
  const binding: EpochBinding = Object.freeze({ endpoint: claudeEndpoint,
    identity: Object.freeze({ pid: 73, uid: 501, pidVersion: 1, uniqueId: '700' }),
    nativeSessionId: claudeEndpoint.nativeSessionId, epoch: 'synthetic-epoch',
    route: Object.freeze({ schemaVersion: 1, endpoint: claudeEndpoint,
      socket: '/synthetic/fixture.sock', ownerPid: 73, ownerStart: 'synthetic-start' }) });
  const duplex = createDuplex({ host: { surface: 'desktop', version: '0.2.0-rc.2',
    storageNamespace: 'a'.repeat(64), hostInstanceId: 'synthetic-host', routeGeneration: 'synthetic-generation',
    getAgent: id => id === agent.id ? agent : undefined, isArchived: () => false },
    verifyClaude: async value => { assert.strictEqual(value, binding); }, assertClaudeCurrent: () => undefined, assertOpen() {}, guardDispatch() {} });
  const exec = { agent, signal: new AbortController().signal } as ToolRunContext;
  const sourceFrames: Envelope[] = []; const targetFrames: Envelope[] = [];
  const source = duplex.registerDsh(exec, frame => { sourceFrames.push(frame); return accepted; });
  const target = await duplex.registerClaude(binding, frame => { targetFrames.push(frame); return receive(frame); });
  const seen: ToolRunContext[] = []; const requests: { operation: string; input: unknown }[] = [];
  const connection: DuplexConnection = Object.freeze({ ...source,
    connect(id: string) { requests.push({ operation: 'connect', input: id }); return source.connect(id); },
    send(input: unknown) { requests.push({ operation: 'send', input }); return source.send(input); },
    reply(input: unknown) { requests.push({ operation: 'reply', input }); return source.reply(input); } });
  const tools: readonly ToolDefinition[] = createDshDuplexTools((execution: ToolRunContext) => {
    seen.push(execution); assert.strictEqual(execution.agent, agent); return connection;
  });
  return { tools, exec, agent, seen, requests, sourceFrames, targetFrames, source, target, binding };
}

test('duplex factory exists and defines exactly the three cross-Harness tools', async () => {
  assert.equal(typeof createDshDuplexTools, 'function');
  const f = await fixture();
  assert.deepEqual(f.tools.map(tool => tool.name), ['router_connect_claude', 'router_send', 'router_reply']);
  assert.ok(Object.isFrozen(f.tools));
  for (const tool of f.tools) assert.match(tool.description, /跨 Harness/);
  assert.match(f.tools[0].description, /不.*迁移/);
  assert.match(f.tools[1].description, /不.*取信/);
  assert.match(f.tools[2].description, /原消息/);
});

test('official definitions preserve exact execution and v1 send/reply shapes and raw body', async () => {
  const f = await fixture();
  const connected = await f.tools[0].execute({ targetSessionId: f.binding.nativeSessionId }, f.exec) as { linkId: string; targetSessionId: string };
  assert.strictEqual(f.seen[0], f.exec);
  assert.deepEqual(Object.keys(connected).sort(), ['linkId', 'targetSessionId']);
  const body = ' 原文\n😀 $HOME $(echo synthetic) ';
  const sent = await f.tools[1].execute({ messageId: 'send-1', linkId: connected.linkId, body }, f.exec) as ToolValue;
  assert.deepEqual(f.requests[1], { operation: 'send', input: { schemaVersion: 1, messageId: 'send-1', linkId: connected.linkId, body } });
  assert.equal(f.targetFrames[0].body, body);
  await f.target.send({ schemaVersion: 1, messageId: 'incoming-1', linkId: connected.linkId, body: 'incoming' });
  const answer = await f.tools[2].execute({ messageId: 'answer-1', inReplyTo: 'incoming-1', body }, f.exec) as ToolValue;
  assert.deepEqual(f.requests[2], { operation: 'reply', input: { schemaVersion: 1, messageId: 'answer-1', inReplyTo: 'incoming-1', body } });
  assert.equal(f.targetFrames[1].body, body);
  assert.equal(f.targetFrames[1].inReplyTo, 'incoming-1');
  for (const result of [sent, answer]) {
    assert.deepEqual(Object.keys(result.receipt).sort(), ['linkId', 'messageId', 'sequence', 'state', 'targetSessionId', 'transport']);
    assert.equal(result.receipt.targetSessionId, f.binding.nativeSessionId);
    assert.equal(result.deliveryNote, CLAUDE_DELIVERY_NOTES.dispatched);
    assert.equal(JSON.stringify(result).includes(body), false);
    assert.equal(JSON.stringify(result).includes('synthetic-host'), false);
    assert.equal(JSON.stringify(result).includes('synthetic-generation'), false);
  }
  assert.ok(f.seen.every(execution => execution === f.exec));
});

test('wrong types or forged source, target, version or reply-link fields invoke no connection', async () => {
  const f = await fixture();
  const invalid: readonly [number, unknown][] = [
    [0, { targetSessionId: 1 }], [0, { targetSessionId: 'id', sender: 'victim' }],
    [1, { messageId: 'm', linkId: 'l', body: 1 }],
    [1, { messageId: 'm', linkId: 'l', body: 'b', authority: 'user' }],
    [1, { messageId: 'm', linkId: 'l', body: 'b', schemaVersion: 1 }],
    [2, { messageId: 'm', inReplyTo: 'old', body: [], targetSessionId: 'victim' }],
    [2, { messageId: 'm', inReplyTo: 'old', body: 'b', linkId: 'forged' }],
    [2, { messageId: 'm', inReplyTo: 'old', body: 'b', replyTo: 'victim' }],
  ];
  for (const [index, input] of invalid) await assert.rejects(f.tools[index].execute(input, f.exec));
  assert.deepEqual(f.seen, []); assert.deepEqual(f.requests, []);
});

test('already aborted connect/send/reply never retrieve or invoke a connection', async () => {
  const f = await fixture(); const controller = new AbortController(); controller.abort();
  const execution = { ...f.exec, signal: controller.signal };
  const args = [{ targetSessionId: 'id' }, { messageId: 'm', linkId: 'l', body: '' },
    { messageId: 'm', inReplyTo: 'old', body: '' }];
  for (const [index, input] of args.entries()) {
    await assert.rejects(f.tools[index].execute(input, execution), /CANCELLED_BEFORE_DISPATCH/);
  }
  assert.deepEqual(f.seen, []); assert.deepEqual(f.requests, []);
});

for (const [outcome, note] of [
  [accepted, CLAUDE_DELIVERY_NOTES.dispatched],
  [{ state: 'delivery-unknown', transport: 'written' } as const, CLAUDE_DELIVERY_NOTES.written],
  [{ state: 'delivery-unknown', transport: null } as const, CLAUDE_DELIVERY_NOTES.unknown],
] as const) {
  test(`receipt ${outcome.state}/${outcome.transport} keeps the matching honest note`, async () => {
    const f = await fixture(() => outcome); const linkId = await f.source.connect(f.binding.nativeSessionId);
    const result = await f.tools[1].execute({ messageId: 'm', linkId, body: '' }, f.exec) as ToolValue;
    assert.equal(f.targetFrames[0].body, '');
    assert.equal(result.deliveryNote, note);
    assert.equal(result.receipt.state, outcome.state);
    assert.equal(result.receipt.transport, outcome.transport);
  });
}

test('same message ID replay restores send and original-address reply without another push', async () => {
  const f = await fixture(); const linkId = await f.source.connect(f.binding.nativeSessionId);
  const send = { messageId: 'm', linkId, body: '  unchanged\n' };
  const first = await f.tools[1].execute(send, f.exec);
  assert.deepEqual(await f.tools[1].execute(send, f.exec), first);
  assert.equal(f.targetFrames.length, 1);
  await f.target.send({ schemaVersion: 1, messageId: 'incoming', linkId, body: 'original incoming' });
  const reply = { messageId: 'reply', inReplyTo: 'incoming', body: ' response\n' };
  const original = await f.tools[2].execute(reply, f.exec);
  assert.deepEqual(await f.tools[2].execute(reply, f.exec), original);
  assert.equal(f.targetFrames.length, 2);
});

test('unknown or nonrecipient original message is rejected without a reply push', async () => {
  const f = await fixture(); const linkId = await f.source.connect(f.binding.nativeSessionId);
  await assert.rejects(f.tools[2].execute({ messageId: 'r', inReplyTo: 'missing', body: '' }, f.exec), /UNKNOWN_MESSAGE/);
  await f.tools[1].execute({ messageId: 'outgoing', linkId, body: '' }, f.exec);
  await assert.rejects(f.tools[2].execute({ messageId: 'r', inReplyTo: 'outgoing', body: '' }, f.exec), /NOT_RECIPIENT/);
  assert.equal(f.targetFrames.length, 1);
});

test('large body remains original and absent from canonical and rendered send/reply results', async () => {
  const f = await fixture(); const linkId = await f.source.connect(f.binding.nativeSessionId);
  const body = ' 原文 👋\n'.repeat(10000);
  const send = { messageId: 'm', linkId, body };
  const sent = await f.tools[1].execute(send, f.exec) as ToolValue;
  await f.target.send({ schemaVersion: 1, messageId: 'incoming', linkId, body: 'incoming' });
  const reply = { messageId: 'r', inReplyTo: 'incoming', body };
  const answered = await f.tools[2].execute(reply, f.exec) as ToolValue;
  assert.equal(f.targetFrames[0].body, body); assert.equal(f.targetFrames[1].body, body);
  for (const [index, args, result] of [[1, send, sent], [2, reply, answered]] as const) {
    assert.equal(JSON.stringify(result).includes(body), false);
    const rendered = JSON.stringify(f.tools[index].output.render(args, result));
    assert.equal(rendered.includes(body), false);
    assert.ok(rendered.length < body.length);
  }
});

for (const operation of ['send', 'reply'] as const) {
  test(`definition ${operation} keeps its owned receipt after cancellation during push`, async () => {
    const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const f = await fixture(async () => { entered.resolve(); await release.promise; return { state: 'delivery-unknown', transport: 'written' }; });
    const linkId = await f.source.connect(f.binding.nativeSessionId);
    if (operation === 'reply') await f.target.send({ schemaVersion: 1, messageId: 'incoming', linkId, body: 'incoming' });
    const args = operation === 'send' ? { messageId: 'm', linkId, body: 'body' }
      : { messageId: 'm', inReplyTo: 'incoming', body: 'body' };
    const controller = new AbortController();
    const execution = { ...f.exec, signal: controller.signal };
    const pending = f.tools[operation === 'send' ? 1 : 2].execute(args, execution);
    try {
      await entered.promise; controller.abort();
      let settled = false; void pending.then(() => { settled = true; });
      await Promise.resolve(); assert.equal(settled, false);
      release.resolve(); const result = await pending as ToolValue;
      assert.equal(result.receipt.transport, 'written');
      assert.equal(result.deliveryNote, CLAUDE_DELIVERY_NOTES.written);
      assert.strictEqual(f.seen[0], execution); assert.equal(f.targetFrames.length, 1);
    } finally { release.resolve(); }
  });

  test(`official SDK ${operation} cancellation waits for owned push and replay recovers original receipt`, async () => {
    const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const f = await fixture(async () => { entered.resolve(); await release.promise; return { state: 'delivery-unknown', transport: 'written' }; });
    const linkId = await f.source.connect(f.binding.nativeSessionId);
    if (operation === 'reply') await f.target.send({ schemaVersion: 1, messageId: 'incoming', linkId, body: 'incoming' });
    const args = operation === 'send' ? { messageId: 'm', linkId, body: 'body' }
      : { messageId: 'm', inReplyTo: 'incoming', body: 'body' };
    const ctx = new Context(); new SystemPrompt(ctx, {});
    const scope = createScope(ctx, f.agent); Object.defineProperty(f.agent, 'ctx', { get: () => scope.ctx });
    const runtime = new ToolRuntime(ctx, { mode: 'native' });
    const observed: ToolRunContext[] = [];
    const tool = f.tools[operation === 'send' ? 1 : 2];
    const dispose = runtime.register({ ...tool, execute(input, execution) {
      observed.push(execution); return tool.execute(input, execution);
    } });
    const controller = new AbortController();
    const pending = runtime.execute({ name: tool.name, arguments: args, agent: f.agent,
      callId: 'call-original' as ToolExecutionInput['callId'], signal: controller.signal });
    try {
      await entered.promise; controller.abort();
      let settled = false; void pending.then(() => { settled = true; });
      await Promise.resolve(); assert.equal(settled, false);
      assert.strictEqual(f.seen[0], observed[0]);
      release.resolve(); const aborted = await pending;
      assert.equal(aborted.error?.info?.code, 'ABORTED');
      const replay = await runtime.execute({ name: tool.name, arguments: args, agent: f.agent,
        callId: 'call-replay' as ToolExecutionInput['callId'], signal: new AbortController().signal });
      assert.equal(replay.isError ?? false, false);
      assert.equal((replay.value as ToolValue).receipt.transport, 'written');
      assert.equal(f.targetFrames.length, 1);
    } finally { release.resolve(); dispose(); await scope.dispose(); }
  });
}
