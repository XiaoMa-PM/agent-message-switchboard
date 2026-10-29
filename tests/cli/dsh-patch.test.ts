// INPUT: Synthetic DSH desktop cordis.patch.yml texts in the exact shapes DSH's yaml 2.9.1 writes for the plugin-page entry switch.
// OUTPUT: mentionsId and removeOverrideRows regressions: block and flow override rows removed, anything else naming ms is a conflict,
//         including comments that split a row or sit in a flow sequence and override shapes nested inside
//         another flow item or a quoted scalar.
// POS: Pure text tests for the profile patch layer that ms only cleans on uninstall; no DSH host or real profile.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mentionsId, removeOverrideRows } from '../../src/cli/dsh-patch.ts';

const ID = 'ms-dsh-client';
const USER = '# user note\n- id: ui-theme\n  config:\n    theme: dark\n';

test('mentionsId matches the id as a token, quoted or not, and never a longer id', () => {
  for (const text of [`- id: ${ID}\n`, `- id: "${ID}"\n`, `[ { id: '${ID}', disabled: true } ]\n`, `- insert:\n    - id: ${ID}\n`]) {
    assert.equal(mentionsId(text, ID), true, text);
  }
  for (const text of ['[]\n', `- id: ${ID}-2\n`, `- id: x${ID}\n`, USER]) assert.equal(mentionsId(text, ID), false, text);
});

test('block override rows written by the entry switch are removed; the rest of the file keeps its bytes', () => {
  for (const value of ['true', 'false']) {
    const row = `- id: ${ID}\n  disabled: ${value}\n`;
    assert.deepEqual(removeOverrideRows(USER + row, ID), { text: USER, conflict: false }, value);
    assert.deepEqual(removeOverrideRows(row + USER, ID), { text: USER, conflict: false }, value);
    assert.deepEqual(removeOverrideRows(`- id: "${ID}"\n  disabled: ${value}\n`, ID), { text: '[]\n', conflict: false }, value);
  }
  assert.deepEqual(removeOverrideRows(`${USER}- id: ${ID}\n  disabled: true\n\n`, ID), { text: USER, conflict: false });
});

test('flow override rows (DSH writes flow when the file was missing or []) are removed with their separator', () => {
  const row = `{ id: ${ID}, disabled: true }`;
  const other = '{ id: other, disabled: true }';
  assert.deepEqual(removeOverrideRows(`[ ${row} ]\n`, ID), { text: '[]\n', conflict: false });
  assert.deepEqual(removeOverrideRows(`[ ${other}, ${row} ]\n`, ID), { text: `[ ${other} ]\n`, conflict: false });
  assert.deepEqual(removeOverrideRows(`[ ${row}, ${other} ]\n`, ID), { text: `[ ${other} ]\n`, conflict: false });
  assert.deepEqual(removeOverrideRows(`[\n  ${other},\n  ${row}\n]\n`, ID), { text: `[\n  ${other}\n]\n`, conflict: false });
  for (const neighbour of ['{ id: user, config: { child: [ 1, 2 ] } }', '{ id: other, name: "a]b{c" }', "{ id: other, name: 'x}''y' }", "{ id: other, name: it's }"]) {
    assert.deepEqual(removeOverrideRows(`[ ${neighbour}, ${row} ]\n`, ID), { text: `[ ${neighbour} ]\n`, conflict: false }, neighbour);
  }
});

// A map of the override shape inside another item belongs to that item; only root rows are DSH's switch rows.
test('an override shape nested inside another flow item, or inside a quoted scalar, is a conflict and nothing is removed', () => {
  const row = `{ id: ${ID}, disabled: true }`;
  const cases = [
    `[ { insert: [ ${row}, { id: x, name: y } ] } ]\n`,
    `[ { a: ${row} } ]\n`,
    `[ { id: user, config: { child: ${row} } } ]\n`,
    `[ { id: other, disabled: true }, { a: ${row} } ]\n`,
    `[ ${row}, { a: ${row} } ]\n`,
    `[ { id: other, note: "${row}" } ]\n`,
    `[ { id: other, note: '${row}' } ]\n`,
  ];
  for (const text of cases) assert.deepEqual(removeOverrideRows(text, ID), { text: null, conflict: true }, text);
});

test('a file that never names ms is left alone', () => {
  for (const text of ['[]\n', USER, '[ { id: other, disabled: true } ]\n', '']) {
    assert.deepEqual(removeOverrideRows(text, ID), { text: null, conflict: false }, text);
  }
});

test('any other item naming ms is a conflict and nothing is removed', () => {
  const cases = [
    `- id: ${ID}\n  name: agent-message-switchboard-dsh\n  config: {}\n`,
    `- id: ${ID}\n  disabled: true\n  config: {}\n`,
    `- id: ${ID}\n  disabled: yes\n`,
    `- insert:\n    - id: ${ID}\n      name: /old/index.mjs\n`,
    `- id: ${ID}\n  disabled: true\n- id: ${ID}\n  name: x\n`,
    `[ { id: ${ID}, disabled: true, config: {} } ]\n`,
    `[ { id: ${ID}, disabled: true }, { id: ${ID}, name: x } ]\n`,
    `key: ${ID}\n`,
  ];
  for (const text of cases) assert.deepEqual(removeOverrideRows(text, ID), { text: null, conflict: true }, text);
});

// A comment that splits the ms row must never read as "row already absent" while part of it stays behind.
test('comments that split an override row, or any comment in a flow sequence, are conflicts and nothing is removed', () => {
  const cases = [
    `- id: ${ID}\n# note\n  disabled: true\n`,
    `${USER}- id: ${ID}\n# note\n  disabled: true\n`,
    `- disabled: true\n# note\n  id: ${ID}\n`,
    `-\n  id: ${ID}\n  disabled: true\n`,
    `-\n# note\n  id: ${ID}\n  disabled: true\n`,
    `[\n  # note\n  { id: ${ID}, disabled: true }\n]\n`,
    `[ { id: ${ID}, disabled: true } ] # note\n`,
    `[ { id: other, disabled: true }, # ,\n  { id: ${ID}, disabled: true } ]\n`,
    `# header\n[ { id: other, disabled: true }, { id: ${ID}, disabled: true } ] # trailing\n`,
  ];
  for (const text of cases) assert.deepEqual(removeOverrideRows(text, ID), { text: null, conflict: true }, JSON.stringify(text));
});

test('a blank line inside a block override row is the same YAML map: the whole row goes, nothing of it stays', () => {
  assert.deepEqual(removeOverrideRows(`${USER}- id: ${ID}\n\n  disabled: true\n`, ID), { text: USER, conflict: false });
  assert.deepEqual(removeOverrideRows(`- disabled: true\n\n  id: ${ID}\n${USER}`, ID), { text: USER, conflict: false });
});

