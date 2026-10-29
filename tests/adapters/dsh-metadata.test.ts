// INPUT: Original-session-shaped title service and in-memory workspace fixtures.
// OUTPUT: Native title metadata and explicit unknown-directory regressions.
// POS: Offline DSH collector tests; no host logs, model, rename or refresh.
import {test} from 'node:test';
import assert from 'node:assert/strict';
const url=new URL('../../src/adapters/dsh/metadata.ts',import.meta.url).href;
test('title reads use the original session, workspace matches original ID, and never mutate',async()=>{
 const {collectDshMetadata}=await import(url);const session={header:{id:'s',cwd:'/creation-only'}};
 const agent={id:'s',session};let title:any={title:'自动标题',source:{kind:'provider'}};
 const services={getTitle:(original:unknown)=>{assert.equal(original,session);return title;},listWorkspaces:()=>[{path:'/foreign',sessionIds:['other']},{path:'/project',sessionIds:['s']}]};
 const first=collectDshMetadata(agent,services);
 assert.deepEqual(first,{title:'自动标题',titleProvider:'provider',workspacePath:'/project',cwd:'/creation-only',cwdSource:'session-creation',worktreePath:null,clientSurface:'desktop'});
 title={title:'用户改名',source:{kind:'user'}};assert.equal(collectDshMetadata(agent,services).title,'用户改名');
 assert.equal(first.title,'自动标题');assert.ok(Object.isFrozen(first));
});
test('missing titles, ambiguous workspace and creation cwd never become invented metadata',async()=>{
 const {collectDshMetadata}=await import(url);const agent={id:'s',session:{header:{id:'s',cwd:'/not-current'}}};
 const services={getTitle:()=>undefined,listWorkspaces:()=>[{path:'/a',sessionIds:['s']},{path:'/b',sessionIds:['s']}]};
 assert.deepEqual(collectDshMetadata(agent,services),{title:null,titleProvider:'unknown',workspacePath:null,cwd:'/not-current',cwdSource:'session-creation',worktreePath:null,clientSurface:'desktop'});
});
