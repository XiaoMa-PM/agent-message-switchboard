// INPUT: Synthetic fixed CLI Pre/Post payloads and strict v1 business requests.
// OUTPUT: Skill-name, success, metadata and original-body parsing regressions.
// POS: Pure data boundary tests; event correlation never authenticates a sender.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseBridgeRequest, parseSkillInvocation } from '../../src/bridge/skill-request.ts';

const name = 'agent-message-switchboard:message';
const body = ' \n中文😀 $HOME $(touch canary) `echo marker`\\\"\u2028\u2029 ';
const send = { schemaVersion: 1, operation: 'send', messageId: ' msg ', linkId: ' link ', body };
const list = { schemaVersion: 1, operation: 'list', harness: 'dsh' };

function hook(event = 'PreToolUse', args = JSON.stringify(send)) {
  return { session_id: ' session ', transcript_path: '/synthetic/transcript', cwd: '/synthetic/cwd',
    hook_event_name: event, tool_name: 'Skill', tool_input: { skill: name, args }, tool_use_id: ' call ',
    ...(event === 'PostToolUse' ? { tool_response: { success: true, commandName: name } } : {}) };
}

test('connect send reply preserve nonempty IDs and complete untrimmed body', () => {
  for (const value of [send, { schemaVersion: 1, operation: 'connect', targetSessionId: ' target 😀 ' },
    { schemaVersion: 1, operation: 'reply', messageId: ' msg ', inReplyTo: ' prior ', body: '' }]) {
    const actual = parseBridgeRequest(value);
    assert.deepEqual(actual, value);
    assert.ok(Object.isFrozen(actual));
  }
});

test('read-only list accepts only the fixed three-field DSH request through original Pre/Post hooks', () => {
  const request = parseBridgeRequest(list);
  assert.deepEqual(request, list); assert.ok(Object.isFrozen(request));
  for (const event of ['PreToolUse', 'PostToolUse']) {
    const originalArgs = JSON.stringify(list);
    const invocation = parseSkillInvocation(hook(event, originalArgs));
    assert.deepEqual(invocation.request, list);
    assert.equal(invocation.originalArgs, originalArgs);
    assert.ok(Object.isFrozen(invocation.request));
  }
});

test('list refuses other platforms, absent fields and any identity or path parameters', () => {
  const invalid: unknown[] = [{ schemaVersion: 1, operation: 'list' }, { ...list, schemaVersion: 2 },
    ...[null, '', 'claude-code', 'codex', 'DSH', 'GLM-5.3', ['dsh']].map(harness => ({ ...list, harness }))];
  for (const field of ['targetSessionId', 'sender', 'pid', 'PID', 'cwd', 'projectDir', 'configRoot',
    'directory', 'dirs', 'source', 'authority', 'messageId', 'linkId', 'body']) {
    invalid.push({ ...list, [field]: 'forged' });
  }
  for (const value of invalid) assert.throws(() => parseBridgeRequest(value), /^Error: INVALID_BRIDGE_REQUEST$/);
});

test('business operations reject wrong fields, versions and identity claims', () => {
  for (const value of [null, [], {}, { ...send, operation: 'disconnect' }, { ...send, schemaVersion: 2 },
    { ...send, messageId: ' \n' }, { ...send, linkId: '' }, { ...send, body: null },
    { schemaVersion: 1, operation: 'connect', targetSessionId: '' },
    { schemaVersion: 1, operation: 'connect', targetSessionId: 'x', body: '' },
    { schemaVersion: 1, operation: 'reply', messageId: 'x', inReplyTo: '', body: '' }]) {
    assert.throws(() => parseBridgeRequest(value), /^Error: INVALID_BRIDGE_REQUEST$/);
  }
  for (const field of ['sender', 'replyTo', 'from', 'pid', 'authority', 'recipient', 'targetSessionId']) {
    assert.throws(() => parseBridgeRequest({ ...send, [field]: 'forged' }), /^Error: INVALID_BRIDGE_REQUEST$/);
  }
});

test('native Pre and successful Post return frozen correlation and request only', () => {
  for (const event of ['PreToolUse', 'PostToolUse']) {
    const originalArgs = JSON.stringify(send);
    const actual = parseSkillInvocation(hook(event, originalArgs));
    assert.deepEqual(actual, { event, sessionId: ' session ', toolUseId: ' call ', request: send, originalArgs });
    assert.ok(Object.isFrozen(actual));
    assert.ok(Object.isFrozen(actual.request));
    assert.equal('authority' in actual, false);
  }
});

test('known fixed native metadata is validated then omitted from output', () => {
  const input = { ...hook('PostToolUse'), prompt_id: 'prompt', permission_mode: 'default',
    agent_id: 'subagent', agent_type: 'general-purpose', scratchpad_dir: '/synthetic/scratch',
    effort: { level: 'low' }, duration_ms: 12.5 };
  assert.deepEqual(parseSkillInvocation(input), parseSkillInvocation(hook('PostToolUse')));
  for (const field of ['prompt_id', 'permission_mode', 'agent_id', 'agent_type', 'scratchpad_dir']) {
    assert.throws(() => parseSkillInvocation({ ...input, [field]: 5 }), /^Error: INVALID_SKILL_INVOCATION$/);
  }
  for (const effort of [null, [], {}, { level: 1 }, { level: 'low', authority: 'user' }]) {
    assert.throws(() => parseSkillInvocation({ ...input, effort }), /^Error: INVALID_SKILL_INVOCATION$/);
  }
  for (const duration_ms of [-1, NaN, Infinity, '12']) {
    assert.throws(() => parseSkillInvocation({ ...input, duration_ms }), /^Error: INVALID_SKILL_INVOCATION$/);
  }
});

test('unknown native fields and missing required metadata fail closed', () => {
  for (const field of ['sender', 'pid', 'authority', 'mcp_server', 'tool_response', 'duration_ms']) {
    assert.throws(() => parseSkillInvocation({ ...hook(), [field]: {} }), /^Error: INVALID_SKILL_INVOCATION$/);
  }
  for (const field of ['session_id', 'transcript_path', 'cwd', 'hook_event_name', 'tool_name', 'tool_input', 'tool_use_id']) {
    const input: Record<string, unknown> = hook();
    delete input[field];
    assert.throws(() => parseSkillInvocation(input), /^Error: INVALID_SKILL_INVOCATION$/);
  }
  for (const input of [null, [], {}, { ...hook(), session_id: ' ' }, { ...hook(), tool_use_id: '' },
    { ...hook(), cwd: 1 }, { ...hook(), transcript_path: null }]) {
    assert.throws(() => parseSkillInvocation(input), /^Error: INVALID_SKILL_INVOCATION$/);
  }
});

test('only exact Skill tool and full skill name are accepted', () => {
  for (const tool_name of ['Bash', 'skill__agent-message-switchboard__message', 'skill', ' Skill']) {
    assert.throws(() => parseSkillInvocation({ ...hook(), tool_name }), /^Error: INVALID_SKILL_INVOCATION$/);
  }
  for (const skill of ['message', '/agent-message-switchboard:message', ' agent-message-switchboard:message',
    'agent-message-switchboard:message ', 'other:message']) {
    assert.throws(() => parseSkillInvocation({ ...hook(), tool_input: { skill, args: JSON.stringify(send) } }),
      /^Error: INVALID_SKILL_INVOCATION$/);
  }
});

test('tool input is exact and args must contain valid strict business JSON', () => {
  for (const tool_input of [null, [], { skill: name }, { skill: name, args: send },
    { skill: name, args: '' }, { skill: name, args: 'private invalid JSON' },
    { skill: name, args: JSON.stringify({ ...send, sender: 'fake' }) },
    { skill: name, args: JSON.stringify(send), pid: 1 }]) {
    assert.throws(() => parseSkillInvocation({ ...hook(), tool_input }), /^Error: INVALID_SKILL_INVOCATION$/);
  }
});

test('Post rejects failures, read-only, forks, background and permission grants', () => {
  const success = { success: true, commandName: name };
  for (const tool_response of [null, [], {}, { ...success, success: false },
    { ...success, commandName: 'message' }, { ...success, readOnly: true },
    { ...success, status: 'forked' }, { ...success, background: false },
    { ...success, allowedTools: [] }, { ...success, model: 'other-model' },
    { ...success, agentId: 'child' }, { ...success, result: 'result' }, { ...success, unknown: 1 }]) {
    assert.throws(() => parseSkillInvocation({ ...hook('PostToolUse'), tool_response }), /^Error: INVALID_SKILL_INVOCATION$/);
  }
  for (const extra of [{}, { readOnly: false }, { status: 'inline' }, { readOnly: false, status: 'inline' }]) {
    assert.equal(parseSkillInvocation({ ...hook('PostToolUse'), tool_response: { ...success, ...extra } }).event, 'PostToolUse');
  }
  assert.throws(() => parseSkillInvocation({ ...hook('PostToolUse'), tool_response: undefined }), /^Error: INVALID_SKILL_INVOCATION$/);
});

test('failure and lifecycle events cannot become communication requests', () => {
  for (const event of ['PostToolUseFailure', 'SessionStart', 'SessionEnd', 'PermissionRequest', 'UserPromptExpansion']) {
    assert.throws(() => parseSkillInvocation(hook(event)), /^Error: INVALID_SKILL_INVOCATION$/);
  }
});

test('standard duplicate-key semantics do not erase exact original args', () => {
  const originalArgs = '{"schemaVersion":2,"schemaVersion":1,"operation":"send","messageId":"m","linkId":"l","body":"first","body":"final"}';
  const first = parseSkillInvocation(hook('PreToolUse', originalArgs));
  const second = parseSkillInvocation(hook('PostToolUse', JSON.stringify(first.request)));
  assert.equal(first.originalArgs, originalArgs);
  assert.deepEqual(first.request, second.request);
  assert.notEqual(first.originalArgs, second.originalArgs);
});

test('parsed snapshots do not retain mutable native input or execute accessors', () => {
  const input = hook();
  const actual = parseSkillInvocation(input);
  input.tool_input.args = JSON.stringify({ ...send, body: 'changed' });
  assert.deepEqual(actual.request, send);
  const getter = Object.defineProperty({}, 'operation', { enumerable: true, get() { throw new Error('secret getter'); } });
  assert.throws(() => parseBridgeRequest(getter), /^Error: INVALID_BRIDGE_REQUEST$/);
});
