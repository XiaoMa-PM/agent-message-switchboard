// INPUT: Fixed official Cordis/SystemPrompt scopes and trusted Harness source values.
// OUTPUT: Offline additive guidance, service-get scope and exact cleanup regression evidence.
// POS: DSH routing guidance seam; no host, model, directory lookup or transport execution.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { createScope } from '@deepseek-ai/dsh-scope';
import { SystemPrompt, renderContextSnapshot, renderPrompt } from '@deepseek-ai/dsh-system-prompt';
import { installRoutingGuidance } from '../../src/adapters/dsh/routing-guidance.ts';
import { routingGuidance } from '../../src/routing/policy.ts';

const sectionName = 'agent-message-switchboard:routing';
const unavailable = { message: 'ROUTING_GUIDANCE_UNAVAILABLE' };

function fixture() {
  const ctx = new Context();
  const prompt = new SystemPrompt(ctx, {
    personaPrefix: 'Original {{model}} persona', personaSuffix: 'Original suffix',
  });
  prompt.variable('model', () => 'fixture-model');
  prompt.context({ name: 'sandbox', order: prompt.getContextOrder('SANDBOX_POLICY'),
    text: 'Original sandbox: restricted workspace' });
  const target = {};
  const other = {};
  const scope = createScope(ctx, target);
  const otherScope = createScope(ctx, other);
  scope.ctx.systemPrompt.context({ name: 'approval',
    order: prompt.getContextOrder('APPROVAL_POLICY'), text: 'Original approval: ask' });
  otherScope.ctx.systemPrompt.context({ name: 'approval',
    order: prompt.getContextOrder('APPROVAL_POLICY'), text: 'Other approval: hold' });
  return { ctx, prompt, target, other, scope, otherScope };
}

for (const lookup of ['get', 'property'] as const) {
  test(`${lookup} service lookup appends only to target scope and preserves all original input`, async () => {
    const f = fixture();
    try {
      const targetBefore = await f.prompt.assemble({ scope: f.target });
      const otherBefore = await f.prompt.assemble({ scope: f.other });
      const globalBefore = await f.prompt.assemble();
      const service = lookup === 'get'
        ? f.scope.ctx.get('systemPrompt') : f.scope.ctx.systemPrompt;
      assert.ok(service);
      const dispose = installRoutingGuidance(service, 'dsh');
      const targetAfter = await f.prompt.assemble({ scope: f.target });
      const guidance = targetAfter.sections.filter(section => section.name === sectionName);
      assert.deepEqual(guidance, [{ name: sectionName, text: routingGuidance('dsh'),
        interpolate: false }]);
      assert.deepEqual({ ...targetAfter,
        sections: targetAfter.sections.filter(section => section.name !== sectionName) }, targetBefore);
      assert.deepEqual(await f.prompt.assemble({ scope: f.other }), otherBefore);
      assert.deepEqual(await f.prompt.assemble(), globalBefore);
      assert.equal(renderContextSnapshot(targetAfter), renderContextSnapshot(targetBefore));
      assert.equal(renderPrompt(targetAfter).includes('Original fixture-model persona'), true);
      assert.equal(renderPrompt(targetAfter).includes('Original suffix'), true);
      dispose(); dispose();
      assert.deepEqual(await f.prompt.assemble({ scope: f.target }), targetBefore);
      assert.deepEqual(await f.prompt.assemble({ scope: f.other }), otherBefore);
    } finally { await f.scope.dispose(); await f.otherScope.dispose(); }
  });
}

test('duplicate install rejects with a fixed error and retains the existing owned section', async () => {
  const f = fixture();
  try {
    const service = f.scope.ctx.get('systemPrompt');
    const dispose = installRoutingGuidance(service, 'dsh');
    const before = await f.prompt.assemble({ scope: f.target });
    assert.throws(() => installRoutingGuidance(service, 'claude-code'), unavailable);
    assert.deepEqual(await f.prompt.assemble({ scope: f.target }), before);
    dispose();
    const nextDispose = installRoutingGuidance(service, 'codex');
    dispose();
    const next = await f.prompt.assemble({ scope: f.target });
    assert.equal(next.sections.find(section => section.name === sectionName)?.text,
      routingGuidance('codex'));
    nextDispose(); nextDispose();
    assert.equal((await f.prompt.assemble({ scope: f.target })).sections
      .some(section => section.name === sectionName), false);
  } finally { await f.scope.dispose(); await f.otherScope.dispose(); }
});

test('scope disposal removes its guidance and retains the other scope contribution', async () => {
  const f = fixture();
  try {
    const globalBefore = await f.prompt.assemble();
    const dispose = installRoutingGuidance(f.scope.ctx.get('systemPrompt'), 'dsh');
    const otherDispose = installRoutingGuidance(f.otherScope.ctx.get('systemPrompt'), 'claude-code');
    const otherBefore = await f.prompt.assemble({ scope: f.other });
    await f.scope.dispose();
    dispose(); dispose();
    assert.deepEqual(await f.prompt.assemble({ scope: f.target }), globalBefore);
    assert.deepEqual(await f.prompt.assemble({ scope: f.other }), otherBefore);
    otherDispose();
    assert.equal((await f.prompt.assemble({ scope: f.other })).sections
      .some(section => section.name === sectionName), false);
  } finally { await f.scope.dispose(); await f.otherScope.dispose(); }
});

test('an unavailable official service rejects without installing any guidance', () => {
  const ctx = new Context();
  assert.equal(ctx.get('systemPrompt'), undefined);
  assert.throws(() => installRoutingGuidance(ctx.get('systemPrompt'), 'dsh'), unavailable);
  assert.throws(() => installRoutingGuidance(null, 'dsh'), unavailable);
});

test('registration uses the official session-query placement and returns only its exact disposer', () => {
  const ctx = new Context();
  const prompt = new SystemPrompt(ctx, {});
  const order = prompt.getSectionOrder('TOOL_SESSION_QUERY');
  const dispose = () => {};
  const calls: unknown[] = [];
  const actual = installRoutingGuidance({
    getSectionOrder(name) { calls.push(name); return order; },
    section(section) { calls.push(section); return dispose; },
  }, 'dsh');
  assert.equal(actual, dispose);
  assert.deepEqual(calls, ['TOOL_SESSION_QUERY', {
    name: sectionName, order, text: routingGuidance('dsh'), interpolate: false,
  }]);
});

test('order and registration errors disclose no provider internals', () => {
  const secret = 'provider-private-path';
  const order = new SystemPrompt(new Context(), {}).getSectionOrder('TOOL_SESSION_QUERY');
  let registrations = 0;
  assert.throws(() => installRoutingGuidance({
    getSectionOrder() { throw new Error(secret); },
    section() { registrations += 1; return () => {}; },
  }, 'dsh'), unavailable);
  assert.equal(registrations, 0);
  assert.throws(() => installRoutingGuidance({
    getSectionOrder() { return order; },
    section() { throw new Error(secret); },
  }, 'dsh'), unavailable);
});
