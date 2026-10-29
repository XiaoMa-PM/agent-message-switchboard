// INPUT: Synthetic compact results and nested native hook JSON escaping.
// OUTPUT: Whole-frame capacity checks without truncation, transport or dispatch.
// POS: Offline shared output-capacity regressions for authenticated Skill results.
import assert from 'node:assert/strict';
import { test } from 'node:test';
const moduleUrl = new URL('../../src/bridge/hook-output.ts', import.meta.url).href;
test('ordinary results pass and both RPC and nested native output remain bounded', async () => {
  const { assertHookOutputCapacity } = await import(moduleUrl);
  assert.doesNotThrow(() => assertHookOutputCapacity({ sessions: [], note: '中文😀' }));
  assert.doesNotThrow(() => assertHookOutputCapacity({ body: 'x'.repeat(10001) }));
  assert.throws(() => assertHookOutputCapacity({ title: 'x'.repeat(1048576) }), /IPC_FRAME_TOO_LARGE/);
  assert.throws(() => assertHookOutputCapacity({ title: '"'.repeat(350000) }), /IPC_FRAME_TOO_LARGE/);
});
