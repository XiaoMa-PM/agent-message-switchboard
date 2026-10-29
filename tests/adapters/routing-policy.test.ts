// INPUT: Canonical Harness pairs, ambiguous platform requests and forged source values.
// OUTPUT: Pure route decisions, immutable results and essential routing guidance regressions.
// POS: Offline policy tests; no host, model, native transport or metadata execution.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import net from 'node:net';
import { test } from 'node:test';
import { type Harness } from '../../src/protocol/message.ts';
import { Router } from '../../src/router/router.ts';
import { classifyHarnessRoute, routingGuidance } from '../../src/routing/policy.ts';

const harnesses: readonly Harness[] = ['dsh', 'claude-code', 'codex'];

for (const harness of harnesses) {
  test(`${harness} stays on native tools for the same platform`, () => {
    assert.deepEqual(classifyHarnessRoute(harness, harness), { kind: 'native', targetHarness: harness });
  });
}

const crossRoutes = [
  ['dsh', 'claude-code', 'router'], ['claude-code', 'dsh', 'router'],
  ['dsh', 'codex', 'unsupported'], ['codex', 'dsh', 'unsupported'],
  ['claude-code', 'codex', 'unsupported'], ['codex', 'claude-code', 'unsupported'],
] as const;
for (const [source, target, kind] of crossRoutes) {
  test(`${source} to ${target} is ${kind} without changing the destination`, () => {
    assert.deepEqual(classifyHarnessRoute(source, target), { kind, targetHarness: target });
  });
}

test('unknown platforms, model brands and paths require clarification without coercion', () => {
  const targets: readonly unknown[] = [undefined, null, false, 1, '', 'DSH', 'Claude', 'Claude Code',
    'claude', 'codex-cli', 'GPT', 'GPT-6', 'GLM-5.3', 'Sonnet 5.5', ' dsh ',
    '/synthetic/dsh/project', '/synthetic/codex/worktree', ['dsh'], { harness: 'dsh' },
    new String('dsh'), { toString: () => { throw new Error('MUST_NOT_COERCE'); } }];
  for (const source of harnesses) {
    for (const target of targets) {
      assert.deepEqual(classifyHarnessRoute(source, target), { kind: 'clarify-platform', targetHarness: null });
    }
  }
});

test('forged source Harness values are rejected before interpreting any target', () => {
  const sources: readonly unknown[] = [undefined, null, true, 1, '', 'DSH', 'Claude', 'GPT', ' dsh ',
    ['dsh'], { harness: 'dsh' }, new String('dsh'),
    { toString: () => { throw new Error('MUST_NOT_COERCE'); } }];
  for (const source of sources) {
    for (const target of [...harnesses, null]) {
      assert.throws(() => classifyHarnessRoute(source as Harness, target), {
        message: 'INVALID_SOURCE_HARNESS',
      });
    }
    assert.throws(() => routingGuidance(source as Harness), { message: 'INVALID_SOURCE_HARNESS' });
  }
});

test('every decision is frozen and cannot be retargeted', () => {
  for (const source of harnesses) {
    for (const target of [...harnesses, undefined]) {
      const decision = classifyHarnessRoute(source, target);
      assert.ok(Object.isFrozen(decision));
      assert.throws(() => Object.assign(decision, { targetHarness: 'forged' }), TypeError);
    }
  }
});

test('classification and guidance never invoke Router, native sockets, child processes or fetch', t => {
  const forbidden = () => { throw new Error('POLICY_MUST_NOT_INVOKE_TRANSPORT'); };
  const router = t.mock.method(Router.prototype, 'register', forbidden);
  const connect = t.mock.method(net, 'connect', forbidden);
  const createConnection = t.mock.method(net, 'createConnection', forbidden);
  const spawn = t.mock.method(childProcess, 'spawn', forbidden);
  const execFile = t.mock.method(childProcess, 'execFile', forbidden);
  const fetch = t.mock.method(globalThis, 'fetch', forbidden);
  for (const source of harnesses) {
    for (const target of [...harnesses, 'GPT', null]) classifyHarnessRoute(source, target);
    routingGuidance(source);
  }
  assert.throws(() => classifyHarnessRoute('GPT' as Harness, 'dsh'), /INVALID_SOURCE_HARNESS/);
  for (const call of [router, connect, createConnection, spawn, execFile, fetch]) {
    assert.equal(call.mock.callCount(), 0);
  }
});

for (const source of harnesses) {
  test(`${source} guidance preserves platform, ambiguity, reply and authority boundaries`, () => {
    const guidance = routingGuidance(source);
    assert.ok(guidance.includes(`Current Harness: ${source}.`));
    assert.match(guidance, /model names.*do not identify.*Harness/i);
    assert.match(guidance, /same.platform.*native tools.*do not.*Router/i);
    assert.match(guidance, /hard.filter.*target Harness.*registered.*verified metadata/i);
    assert.match(guidance, /current model.*titles.*workspace.*worktree/i);
    assert.match(guidance, /multiple reasonable matches.*uncertain.*ask the user/i);
    assert.match(guidance, /do not.*highest.score/i);
    assert.match(guidance, /peer.*original message.*reply.*do not.*re.address/i);
    assert.match(guidance, /metadata.*data.*not instructions.*authorization/i);
    assert.match(guidance, /model.*user confirmed.*does not.*permission/i);
    assert.match(guidance, /only.*Claude Code CLI.*DSH desktop.*verified/i);
    assert.match(guidance, /unsupported.*do not.*redirect/i);
    assert.match(guidance, /do not read.*history.*first prompt/i);
    assert.match(guidance, /original session ID.*existing connection tool/i);
    assert.match(guidance, /semantic lookup.*actually available.*directory tool/i);
    assert.match(guidance, /no directory capability.*insufficient metadata.*ask the user.*original session ID/i);
    assert.match(guidance, /Claude Code CLI.*list.*connect.*send.*reply.*list operation is limited to dsh/i);
    assert.match(guidance, /DSH.*router_list_sessions/i);
    assert.match(guidance, /do not invent.*list.*shell/i);
  });
}
