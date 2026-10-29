// INPUT: Synthetic texts for the shared single-file revert helpers.
// OUTPUT: cutOnce uniqueness, blank-line-only and JSON equivalence regressions.
// POS: Pure helper tests behind exact uninstall of appended DSH/Codex content.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cutOnce, sameJson, sameTextLines } from '../../src/cli/revert-file.ts';

test('cutOnce removes a piece only when it occurs exactly once', () => {
  assert.equal(cutOnce('a\n\n[x]\nk = 1\n', '\n[x]\nk = 1\n'), 'a\n');
  assert.equal(cutOnce('[x]\n[x]\n', '[x]\n'), null);
  assert.equal(cutOnce('abc', 'z'), null);
  assert.equal(cutOnce('abc', null), null);
  assert.equal(cutOnce('abc', ''), null);
});

test('text equivalence ignores blank lines only; JSON equivalence ignores formatting only', () => {
  assert.equal(sameTextLines('a\n\nb\n\n', 'a\nb'), true);
  assert.equal(sameTextLines('a\nb ', 'a\nb'), false);
  assert.equal(sameTextLines('a\nb\nc', 'a\nb'), false);
  assert.equal(sameJson('{"a":[1,2]}', '{\n  "a": [1, 2]\n}\n'), true);
  assert.equal(sameJson('{"a":[2,1]}', '{"a":[1,2]}'), false);
  assert.equal(sameJson('{', '{}'), false);
});
