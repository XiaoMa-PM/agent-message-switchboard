// INPUT: Registered endpoint descriptors and deferred trusted metadata readers.
// OUTPUT: Platform-filtered refreshed records and no late query publication.
// POS: Offline directory composition; no host, worker, models or message dispatch.
import {test} from 'node:test';import assert from 'node:assert/strict';
import {endpoint} from '../helpers/session.ts';
const url=new URL('../../src/registry/session-directory.ts',import.meta.url).href;
const value=(title:string)=>({title,titleProvider:'host' as const,workspacePath:null,cwd:'/synthetic',cwdSource:'session-creation' as const,worktreePath:null,clientSurface:'cli' as const});
test('each query refreshes metadata without changing the original endpoint',async()=>{
 const {createSessionDirectory}=await import(url);const target=endpoint('target','claude-code');let title='自动标题';const seen:unknown[]=[];
 const directory=createSessionDirectory({describe:async(harness:any)=>{assert.equal(harness,'claude-code');return[{endpoint:target,cwd:'/synthetic'}];},verifyEndpoint:async(e:any)=>{seen.push(e);},readMetadata:async()=>value(title)});
 const first=await directory.list('claude-code');title='用户改名';const next=await directory.list('claude-code');
 assert.equal(first[0].metadata.title,'自动标题');assert.equal(next[0].metadata.title,'用户改名');assert.deepEqual(next[0].endpoint,target);assert.equal(next[0].metadataRevision,2);assert.ok(seen.length>=4);
});
test('read failure does not invent metadata or expose raw error text',async()=>{
 const {createSessionDirectory}=await import(url);const target=endpoint('target','claude-code');
 const directory=createSessionDirectory({describe:async()=>[{endpoint:target,cwd:null}],verifyEndpoint:async()=>{},readMetadata:async()=>{throw new Error('secret/path');}});
 await assert.rejects(directory.list('claude-code'),/^Error: METADATA_QUERY_FAILED$/);
});
test('later query supersedes a slow earlier reader without returning obsolete fields',async()=>{
 const {createSessionDirectory}=await import(url);const target=endpoint('target','claude-code');const gate=Promise.withResolvers<void>();let reads=0;
 const directory=createSessionDirectory({describe:async()=>[{endpoint:target,cwd:null}],verifyEndpoint:async()=>{},readMetadata:async()=>{reads++;if(reads===1){await gate.promise;return value('old');}return value('new');}});
 const old=directory.list('claude-code');while(reads===0)await new Promise(r=>setImmediate(r));
 assert.equal((await directory.list('claude-code'))[0].metadata.title,'new');gate.resolve();await assert.rejects(old,/STALE_METADATA_QUERY/);
});
test('a descriptor from another platform never reaches the metadata reader',async()=>{
 const {createSessionDirectory}=await import(url);let reads=0;
 const directory=createSessionDirectory({describe:async()=>[{endpoint:endpoint('foreign','dsh'),cwd:null}],verifyEndpoint:async()=>{},readMetadata:async()=>{reads++;return value('wrong');}});
 await assert.rejects(directory.list('claude-code'),/INVALID_METADATA_DESCRIPTOR/);assert.equal(reads,0);
});
test('an endpoint retired from a successful describe is dropped instead of failing every later list',async()=>{
 const {createSessionDirectory}=await import(url);const kept=endpoint('kept','claude-code');const retired=endpoint('retired','claude-code');
 let rows=[{endpoint:retired,cwd:'/synthetic'},{endpoint:kept,cwd:'/synthetic'}];let live=new Set([retired.endpointId,kept.endpointId]);
 const directory=createSessionDirectory({describe:async()=>rows,verifyEndpoint:async(e:any)=>{if(!live.has(e.endpointId))throw new Error('UNKNOWN_RUNTIME_ENDPOINT');},readMetadata:async()=>value('title')});
 assert.equal((await directory.list('claude-code')).length,2);
 rows=[{endpoint:kept,cwd:'/synthetic'}];live=new Set([kept.endpointId]);
 assert.deepEqual((await directory.list('claude-code')).map((record:any)=>record.endpoint.endpointId),[kept.endpointId]);
 rows=[{endpoint:retired,cwd:'/synthetic'},{endpoint:kept,cwd:'/synthetic'}];live=new Set([retired.endpointId,kept.endpointId]);
 await assert.rejects(directory.list('claude-code'),/^Error: METADATA_QUERY_FAILED$/);
});
