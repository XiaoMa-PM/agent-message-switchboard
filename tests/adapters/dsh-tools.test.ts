// INPUT: Fixed official ToolRuntime, synthetic Router sessions and cancellation gates.
// OUTPUT: Tool validation, authority forwarding, honest receipts and cancellation regressions.
// POS: Offline real SDK pipeline tests, not actual desktop agent-loop evidence.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime, type ToolRunContext, type ToolExecutionInput } from '@deepseek-ai/dsh-tools';
import { type PushOutcome, type Receipt } from '../../src/protocol/message.ts';
import { Router } from '../../src/router/router.ts';
import { endpoint } from '../helpers/session.ts';
import { createDshOutboxTools } from '../../src/adapters/dsh/tools.ts';

type ReceiptView = Pick<Receipt, 'messageId' | 'state' | 'transport'> &
  { sequence: number; linkId: string; targetSessionId: string };
type ToolValue = { receipt: ReceiptView; deliveryNote: string };

function fixture(push: () => Promise<PushOutcome> = async () => ({ state: 'delivery-unknown', transport: 'written' })) {
  const router = new Router();
  const source = router.register(endpoint('source'), () => ({ state: 'delivery-unknown', transport: null }));
  const target = endpoint('target', 'claude-code');
  router.register(target, push);
  const seen: unknown[] = [];
  const outbox = { async connect(exec: unknown, id: string) { seen.push(exec, id); return source.connect(target.endpointId); },
    async send(exec: unknown, input: unknown) { seen.push(exec); return source.send(input); } };
  const tools = createDshOutboxTools(outbox);
  const signal = new AbortController().signal;
  const exec = { signal, agent: { id: 'source' } } as unknown as ToolRunContext;
  return { tools, exec, seen, outbox };
}

test('official definitions validate parameters and forward trusted execution with v1 requests', async () => {
  const f = fixture();
  assert.deepEqual(f.tools.map(tool => tool.name), ['router_connect_claude', 'router_send']);
  const connection = await f.tools[0].execute({ targetSessionId: 'synthetic-uuid' }, f.exec) as { linkId: string };
  assert.equal(f.seen[0], f.exec);
  const result = await f.tools[1].execute({ messageId: 'message-A', linkId: connection.linkId, body: '原文 👋' }, f.exec) as ToolValue;
  assert.deepEqual(Object.keys(result.receipt).sort(), ['linkId', 'messageId', 'sequence', 'state', 'targetSessionId', 'transport']);
  assert.equal(result.receipt.targetSessionId, 'synthetic-target');
  assert.equal(result.receipt.sequence, 1);
  assert.equal(result.receipt.linkId, connection.linkId);
  assert.equal(JSON.stringify(result).includes('原文 👋'), false);
  assert.equal(JSON.stringify(result).includes('host-target'), false);
  assert.equal(JSON.stringify(result).includes('run-1'), false);
  assert.equal(result.receipt.transport, 'written');
  assert.match(result.deliveryNote, /未确认/);
  for (const input of [{ targetSessionId: 1 }, { targetSessionId: 'id', sender: 'victim' }]) {
    await assert.rejects(f.tools[0].execute(input, f.exec));
  }
  await assert.rejects(f.tools[1].execute({ messageId: 'other', linkId: connection.linkId, body: 'body', authority: 'user' }, f.exec));
  assert.ok(f.tools[1].description.includes('messageId'));
});

test('null transport is described as no confirmed write evidence, never automatic retry', async () => {
  const f = fixture(async () => ({ state: 'delivery-unknown', transport: null }));
  const connection = await f.tools[0].execute({ targetSessionId: 'id' }, f.exec) as { linkId: string };
  const result = await f.tools[1].execute({ messageId: 'message-A', linkId: connection.linkId, body: 'body' }, f.exec) as ToolValue;
  assert.match(result.deliveryNote, /没有.*写入证据/);
  assert.match(result.deliveryNote, /不会再次派发/);
  assert.match(result.deliveryNote, /不要自动重试/);
});

test('already cancelled tools never invoke the outbox', async () => {
  const f = fixture(); const controller = new AbortController(); controller.abort();
  const exec = { ...f.exec, signal: controller.signal };
  await assert.rejects(f.tools[0].execute({ targetSessionId: 'id' }, exec), /CANCELLED_BEFORE_DISPATCH/);
  await assert.rejects(f.tools[1].execute({ messageId: 'message-A', linkId: 'link', body: 'body' }, exec), /CANCELLED_BEFORE_DISPATCH/);
  assert.equal(f.seen.length, 0);
});

test('SDK cancellation waits for owned work; Router receipt is recovered by exact replay', async () => {
  const gate = Promise.withResolvers<void>(); const entered = Promise.withResolvers<void>();
  let writes = 0;
  const f = fixture(async () => { writes++; entered.resolve(); await gate.promise; return { state: 'delivery-unknown', transport: 'written' }; });
  const ctx = new Context(); new SystemPrompt(ctx, {});
  const runtime = new ToolRuntime(ctx, { mode: 'native' });
  const disposers = f.tools.map(tool => runtime.register(tool));
  const controller = new AbortController();
  const linkId = await f.outbox.connect(f.exec, 'id');
  const args = { messageId: 'message-A', linkId, body: 'original body' };
  const pending = runtime.execute({ name: 'router_send', arguments: args, callId: 'call-A' as ToolExecutionInput['callId'], signal: controller.signal });
  try {
    await entered.promise; controller.abort();
    let settled = false; void pending.then(() => { settled = true; });
    await Promise.resolve(); assert.equal(settled, false);
    gate.resolve();
    const aborted = await pending;
    assert.equal(aborted.error?.info?.code, 'ABORTED');
    const replay = await runtime.execute({ name: 'router_send', arguments: args, callId: 'call-B' as ToolExecutionInput['callId'], signal: new AbortController().signal });
    assert.equal(replay.isError ?? false, false);
    assert.equal((replay.value as ToolValue).receipt.transport, 'written');
    assert.equal(writes, 1);
  } finally { gate.resolve(); for (const dispose of disposers) dispose(); }
});


test('large body remains intact in Router and is absent from canonical and rendered tool output', async () => {
  const f = fixture();
  const connection = await f.outbox.connect(f.exec, 'id');
  const body = '正文 👋'.repeat(10000);
  const request = { messageId: 'message-long', linkId: connection, body };
  const result = await f.tools[1].execute(request, f.exec) as ToolValue;
  const serialized = JSON.stringify(result);
  const internal = await f.outbox.send(f.exec, { schemaVersion: 1, ...request });
  assert.equal(internal.envelope.body, body);
  assert.equal(internal.envelope.recipient.hostInstanceId, 'host-target');
  assert.equal(serialized.includes(body), false);
  assert.ok(serialized.length < body.length);
  const rendered = f.tools[1].output.render(request, result);
  assert.equal(JSON.stringify(rendered).includes(body), false);
  assert.equal(JSON.stringify(rendered).includes('host-target'), false);
  assert.deepEqual(await f.tools[1].execute(request, f.exec), result);
});
