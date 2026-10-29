// INPUT: The shared daily prompt fixture and msd's real Claude hooks driven by an unverifiable caller.
// OUTPUT: Contract: UserPromptSubmit blocks exactly the intercepted prompts, never a letter; the Python daily client asserts the same.
// POS: Cross-language guard between src/bridge/native/runtime_entry.py's local filter and src/daemon/claude-hooks.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createClaudeHooks } from '../../src/daemon/claude-hooks.ts';
import { createSwitchboard } from '../../src/daemon/switchboard.ts';

const prompts = JSON.parse(readFileSync(new URL('./daily-prompts.json', import.meta.url), 'utf8')) as
  Readonly<{ intercepted: readonly string[]; passed: readonly string[]; letters: readonly string[] }>;
const SID = '11111111-1111-4111-8111-111111111111';

test('msd intercepts exactly the shared fixture prompts the Python daily client must forward', async () => {
  const hooks = createClaudeHooks({ board: createSwitchboard(), inspect: async () => null, wrapperPins: () => [],
    python: { path: '/opt/python', sha256: 'a'.repeat(64) },
    auto: { enabled: () => false, allows: () => true, projects: () => [], set: async () => {} },
    reply: { mode: () => 'direct', set: async () => {} },
    makePush: () => async () => ({ state: 'delivery-unknown', transport: 'written' }), makeNotice: () => async () => {},
    projectOf: async cwd => cwd,
    act: { preset: () => 'workspace-write', markers: '/nonexistent/ms-letter-turns', home: '/home/u' } });
  const output = async (prompt: string) => (await hooks.handle({ schemaVersion: 1, requestId: randomUUID(),
    peer: { pid: 99, uid: process.getuid!(), pidVersion: 1 }, snapshots: [[], []],
    payload: { profile: 'daily', messagingSocket: null, hook: { hook_event_name: 'UserPromptSubmit', session_id: SID, prompt } } }) as
    { hookOutput: { decision?: string } }).hookOutput;
  const decide = async (prompt: string) => (await output(prompt)).decision;
  for (const prompt of prompts.intercepted) assert.equal(await decide(prompt), 'block', JSON.stringify(prompt));
  for (const prompt of prompts.passed) assert.equal(await decide(prompt), undefined, JSON.stringify(prompt));
  for (const prompt of prompts.letters) assert.deepEqual(await output(prompt), {}, JSON.stringify(prompt));
});
