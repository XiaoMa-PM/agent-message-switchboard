import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareAppProject } from '../../src/bridge/app-project.ts';
import { createAppSkillProfile } from '../../src/bridge/skill-request.ts';
test('new private project has one precise Skill and four fixed hooks without permissions', async () => {
 const root=await realpath(await mkdtemp(join(tmpdir(),'app-project-'))); const projectPath=join(root,'project');
 const profile=createAppSkillProfile('12345678-1234-4234-8234-123456789abc');
 try {
  const options={projectPath,pythonPath:"/private/python's bin",entryPath:'/private/entry.py',configPath:'/private/config.json'};
  await prepareAppProject(options,profile);
  const settings=JSON.parse(await readFile(join(projectPath,'.claude/settings.json'),'utf8'));
  assert.deepEqual(Object.keys(settings),['hooks']);
  assert.deepEqual(Object.keys(settings.hooks),['SessionStart','SessionEnd','PreToolUse','PostToolUse']);
  assert.equal(settings.hooks.PreToolUse[0].matcher,undefined);
  for(const entries of Object.values(settings.hooks) as any[]) {
   const command=entries[0].hooks[0].command;
   assert.ok(command.includes('/usr/bin/env -i CLAUDE_CODE_MESSAGING_SOCKET="$CLAUDE_CODE_MESSAGING_SOCKET"'));
   assert.ok(command.includes(" -I -S '/private/entry.py' --app-client '/private/config.json'"));
   assert.ok(command.includes("'/private/python'\\''s bin'"));
  }
  const body=await readFile(join(projectPath,'.claude/skills',profile.name,'SKILL.md'),'utf8');
  assert.ok(body.includes(profile.name)); assert.ok(body.includes('peer')); assert.ok(!body.includes('allowed-tools:'));
  assert.equal((await stat(projectPath)).mode&0o777,0o700);
  assert.equal((await stat(join(projectPath,'.claude/settings.json'))).mode&0o777,0o600);
  await assert.rejects(prepareAppProject(options,profile));
 } finally {await rm(root,{recursive:true,force:true});}
});
