import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAppSkillProfile, parseSkillInvocation } from '../../src/bridge/skill-request.ts';
const run = '12345678-1234-4234-8234-123456789abc';
test('App profile fixes exact bare name and strict successful Post', () => {
  const profile = createAppSkillProfile(run);
  assert.equal(profile.name, 'ms-app-message-12345678'); assert.ok(Object.isFrozen(profile));
  const args = ' {"schemaVersion":1,"operation":"list","harness":"dsh"} ';
  const hook = {session_id:'s',transcript_path:'t',cwd:'/x',hook_event_name:'PostToolUse',tool_name:'Skill',tool_input:{skill:profile.name,args},tool_use_id:'u',tool_response:{success:true,commandName:profile.name}};
  assert.equal(profile.parseInvocation(hook).originalArgs,args);
  assert.throws(() => parseSkillInvocation(hook));
  for (const name of ['/'+profile.name,profile.name.toUpperCase(),'agent-message-switchboard:message',profile.name+' ']) {
    assert.throws(() => profile.parseInvocation({...hook,tool_input:{skill:name,args}}));
    assert.throws(() => profile.parseInvocation({...hook,tool_response:{success:true,commandName:name}}));
  }
  for (const id of ['',run.toUpperCase(),'../run',run+'x']) assert.throws(() => createAppSkillProfile(id));
});
test('App parser rejects forged fields, extra profiles and cloned capabilities', async () => {
  const { assertAppSkillProfile } = await import('../../src/bridge/skill-request.ts');
  const profile = createAppSkillProfile(run);
  assert.throws(() => assertAppSkillProfile({...profile}));
  const hook = {session_id:'s',transcript_path:'t',cwd:'/x',hook_event_name:'PreToolUse',tool_name:'Skill',tool_input:{skill:profile.name,args:'{"schemaVersion":1,"operation":"list","harness":"dsh"}'},tool_use_id:'u'};
  for (const extra of [{profile:'app-code'}, {sender:'s'}, {commandName:profile.name}]) {
    assert.throws(() => profile.parseInvocation({...hook,...extra}));
    assert.throws(() => profile.parseInvocation({...hook,tool_input:{...hook.tool_input,...extra}}));
  }
  const other = createAppSkillProfile('87654321-1234-4234-8234-123456789abc');
  assert.throws(() => other.parseInvocation(hook));
});
