// INPUT: Synthetic Codex config.toml texts.
// OUTPUT: appendTables (blank-line separated append), tableHeaders and dropTables (owned blocks removed, neighbours, comments and
//         preamble lines kept byte for byte; `[` lines inside multi-line strings and arrays are values) regressions.
// POS: Pure text tests for the config.toml helpers behind the Codex plugin step; no Codex host or real ~/.codex.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendTables, dropTables, tableHeaders } from '../../src/cli/codex-toml.ts';

const CONFIG = 'model = "gpt"\n\n[mcp_servers.codex]\ncommand = "codex"\n\n# projects follow\n[projects."/p"]\ntrust_level = "trusted"\n';
const SEND = '[plugins."ms@ms-local".mcp_servers.ms.tools.router_send]';
const TABLES = [{ header: SEND, body: ['approval_mode = "approve"'] }, { header: '[x]', body: ['a = 1'] }];

test('tables are appended after the original text with one blank line between them', () => {
  assert.equal(appendTables(CONFIG, TABLES), `${CONFIG}\n${SEND}\napproval_mode = "approve"\n\n[x]\na = 1\n`);
  assert.equal(appendTables(CONFIG.trimEnd(), TABLES), appendTables(CONFIG, TABLES));
  assert.equal(appendTables('', TABLES), `${SEND}\napproval_mode = "approve"\n\n[x]\na = 1\n`);
});

test('tableHeaders lists the trimmed headers in order', () => {
  assert.deepEqual(tableHeaders(appendTables(CONFIG, TABLES)), ['[mcp_servers.codex]', '[projects."/p"]', SEND, '[x]']);
});

test('dropTables removes owned blocks with their trailing blank lines and keeps every other byte', () => {
  const text = appendTables(CONFIG, TABLES);
  assert.equal(dropTables(text, header => header === SEND || header === '[x]'), CONFIG);
  assert.equal(dropTables('a = 1\n[x]\nb = 2\n', header => header === '[x]'), 'a = 1\n');
  assert.equal(dropTables(text, header => header === '[mcp_servers.codex]'),
    `model = "gpt"\n\n# projects follow\n[projects."/p"]\ntrust_level = "trusted"\n\n${SEND}\napproval_mode = "approve"\n\n[x]\na = 1\n`);
  assert.equal(dropTables(text, () => false), text);
  assert.equal(dropTables('[a]\n\n[b]\nk = 1\n', (header, body) => header === '[a]' && body.every(line => line.trim() === '')), '[b]\nk = 1\n');
});

// A line that starts with `[` inside a multi-line string or array is a value, not a table header.
test('lines starting with [ inside multi-line strings or arrays are values; headers after them still count', () => {
  const basic = `[profiles.p]\ninstructions = """\n${SEND}\napproval_mode = "approve"\n"""\n`;
  const literal = `[profiles.p]\ninstructions = '''\n${SEND}\n'''\n`;
  for (const user of [basic, literal]) {
    const text = appendTables(user, TABLES);
    assert.deepEqual(tableHeaders(text), ['[profiles.p]', SEND, '[x]'], user);
    assert.equal(dropTables(text, header => header === SEND || header === '[x]'), user, user);
  }
  const array = '[mcp_servers.m]\nargs = [\n  ["a", "b"],\n  [ "c" ], # ]\n]\n';
  assert.deepEqual(tableHeaders(array), ['[mcp_servers.m]']);
  assert.equal(dropTables(`${array}\n[x]\na = 1\n`, header => header === '[mcp_servers.m]'), '[x]\na = 1\n');
  const closed = 'a = """one "" line"""\nb = "not \\"\\"\\" open"\nc = """x""""\nd = \'\'\'lit\'\'\'\ne = [ "[", \']\' ]\n# """ in a comment\n[x]\nk = 1\n';
  assert.deepEqual(tableHeaders(closed), ['[x]']);
  assert.equal(dropTables(closed, header => header === '[x]'), closed.slice(0, closed.indexOf('[x]')));
});
