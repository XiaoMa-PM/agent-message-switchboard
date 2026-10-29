import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAppHook } from '../../src/bridge/app-hook.ts';
test('App wrapper preserves hook and strictly separates startup', () => {
  const hook = {hook_event_name:'SessionStart',other:'runtime must validate'};
  assert.equal(parseAppHook({profile:'app-code',hook,startup:{socketPath:null}}).hook,hook);
  for (const value of [hook,{profile:'app-code',hook,startup:null},{profile:'app-code',hook,startup:{socketPath:'/x',pid:1}}, {profile:'app-code',hook,startup:{socketPath:1}}, {profile:'app-code',hook,startup:{socketPath:null},extra:1}]) assert.throws(() => parseAppHook(value));
  for (const event of ['SessionEnd','PreToolUse','PostToolUse']) {
    const value={profile:'app-code',hook:{hook_event_name:event},startup:null};
    assert.equal(parseAppHook(value).startup,null);
    assert.throws(() => parseAppHook({...value,startup:{socketPath:'/x'}}));
  }
  assert.throws(() => parseAppHook({profile:'app-code',hook:{hook_event_name:'Unknown'},startup:null}));
});
test('wrapper rejects accessors and preserves lifecycle-invalid Start for runtime revocation', () => {
  let calls=0;
  const value={profile:'app-code',hook:{hook_event_name:'SessionStart',source:'forged'},startup:{socketPath:null}};
  assert.equal(parseAppHook(value).hook,value.hook);
  assert.throws(() => parseAppHook({...value,get startup(){calls++;return null;}}));
  assert.equal(calls,0);
  assert.throws(() => parseAppHook({...value,startup:{socketPath:null,authority:'none'}}));
  assert.throws(() => parseAppHook({...value,profile:'cli'}));
});
