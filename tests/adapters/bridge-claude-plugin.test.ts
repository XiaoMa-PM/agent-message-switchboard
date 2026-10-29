// INPUT: Canonical platform temporary directories and static paths containing shell metacharacters.
// OUTPUT: Isolated one-Skill plugin assets and immutable static hook command regressions.
// POS: Offline package generation only; no installation, shell, native CLI or model invocation.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, stat, mkdir, rm, realpath, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareClaudePlugin } from '../../src/bridge/claude-plugin.ts';

test('generates one inline Skill and four static hooks in a new private directory', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ms-plugin-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'candidate');
  await prepareClaudePlugin({ directory, pythonPath: '/synthetic/python', entryPath: '/synthetic/entry.py', configPath: '/synthetic/client.json' });
  const manifest = JSON.parse(await readFile(join(directory, '.claude-plugin/plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'agent-message-switchboard'); assert.equal(manifest.author.name, 'Agent Message Switchboard');
  const hooks = JSON.parse(await readFile(join(directory, 'hooks/hooks.json'), 'utf8')).hooks;
  assert.deepEqual(Object.keys(hooks), ['SessionStart', 'SessionEnd', 'PreToolUse', 'PostToolUse']);
  for (const [event, groups] of Object.entries(hooks) as Array<[string, any[]]>) {
    assert.equal(groups[0].hooks.length, 1);
    assert.equal(groups[0].hooks[0].command, "/usr/bin/env -i '/synthetic/python' -I -S '/synthetic/entry.py' '/synthetic/client.json'");
    if (event.includes('ToolUse')) assert.equal(groups[0].matcher, 'Skill');
    assert.equal(groups[0].hooks[0].async, undefined);
  }
  const skill = await readFile(join(directory, 'skills/message/SKILL.md'), 'utf8');
  assert.match(skill.split('---')[1], /同.*原生/);
  assert.match(skill, /Current Harness: claude-code/); assert.match(skill, /list operation is limited to dsh/);
  assert.match(skill, /METADATA_CONTEXT_TOO_LARGE/); assert.match(skill, /不使用预览或部分候选/);
  assert.match(skill, /user-invocable: false/); assert.match(skill, /inReplyTo/); assert.match(skill, /operation":"list","harness":"dsh/);
  for (const forbidden of ['allowed-tools:', 'model:', 'context: fork', 'hooks:', '!`']) assert.equal(skill.includes(forbidden), false);
  for (const path of ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'skills/message/SKILL.md']) {
    assert.equal((await stat(join(directory, path))).mode & 0o777, 0o600);
  }
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
});

test('all metacharacters in static paths remain quoted data without interpolation', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ms-plugin-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'candidate'); const path = "/synthetic/a'b $HOME $(echo x) `echo y`";
  await prepareClaudePlugin({ directory, pythonPath: path, entryPath: path, configPath: path });
  const hooks = JSON.parse(await readFile(join(directory, 'hooks/hooks.json'), 'utf8')).hooks;
  const expected = "'" + path.replaceAll("'", "'\\''") + "'";
  assert.equal(hooks.SessionStart[0].hooks[0].command, `/usr/bin/env -i ${expected} -I -S ${expected} ${expected}`);
});

test('existing target and nonprivate parent are rejected without overwriting user files', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ms-plugin-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const input = { directory: join(root, 'exists'), pythonPath: '/synthetic/python', entryPath: '/synthetic/entry', configPath: '/synthetic/config' };
  await mkdir(input.directory, { mode: 0o700 });
  await assert.rejects(prepareClaudePlugin(input), /CLAUDE_PLUGIN_PREPARATION_FAILED/);
  const publicRoot = join(root, 'public'); await mkdir(publicRoot, { mode: 0o755 }); await chmod(publicRoot, 0o755);
  await assert.rejects(prepareClaudePlugin({ ...input, directory: join(publicRoot, 'candidate') }), /CLAUDE_PLUGIN_PREPARATION_FAILED/);
  await assert.rejects(prepareClaudePlugin({ ...input, directory: join(root, 'new'), entryPath: 'relative' }), /CLAUDE_PLUGIN_PREPARATION_FAILED/);
});
