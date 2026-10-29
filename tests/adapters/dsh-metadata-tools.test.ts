// INPUT: Official tool contexts and scoped synthetic metadata directory records.
// OUTPUT: Cross-Harness-only query, original caller checks and narrow metadata projection.
// POS: Offline tool boundary tests; no model or actual host permission decision.
import {test} from 'node:test';import assert from 'node:assert/strict';
import {endpoint} from '../helpers/session.ts';
const url=new URL('../../src/adapters/dsh/metadata-tools.ts',import.meta.url).href;
const record={endpoint:endpoint('target','claude-code'),metadataRevision:2,metadata:{title:'会话标题',titleProvider:'host',workspacePath:'/synthetic',cwd:'/synthetic',cwdSource:'session-creation',worktreePath:null,clientSurface:'cli'}};
test('query binds original execution and only returns display metadata plus native SID',async()=>{
 const {createDshMetadataTool}=await import(url);const execution:any={signal:new AbortController().signal,agent:{id:'original'}};let seen:unknown;
 const tool=createDshMetadataTool((value:any)=>{seen=value;},{list:async(harness:string)=>{assert.equal(harness,'claude-code');return[record];}});
 const result:any=await tool.execute({harness:'claude-code'},execution);assert.equal(seen,execution);
 assert.equal(result.sessions[0].sessionId,record.endpoint.nativeSessionId);assert.equal(result.sessions[0].title,'会话标题');
 for(const key of ['storageNamespace','hostInstanceId','routeGeneration','endpointId'])assert.equal(JSON.stringify(result).includes(key),false);
 assert.match(result.note,/授权/);assert.match(result.note,/创建/);
});
test('same Harness, unknown platform, injected fields and pre-cancelled execution cannot query',async()=>{
 const {createDshMetadataTool}=await import(url);let reads=0;const control=new AbortController();const execution:any={signal:control.signal};
 const tool=createDshMetadataTool(()=>{},{list:async()=>{reads++;return[];}});
 await assert.rejects(tool.execute({harness:'dsh'},execution),/USE_NATIVE_TOOLS/);
 await assert.rejects(tool.execute({harness:'codex'},execution),/UNSUPPORTED_HARNESS_ROUTE/);
 for(const harness of ['Claude','GLM-5.3','/project'])await assert.rejects(tool.execute({harness},execution),/CLARIFY_TARGET_HARNESS/);
 await assert.rejects(tool.execute({harness:'claude-code',from:'forged'},execution),/INVALID_METADATA_QUERY/);
 await assert.rejects(tool.execute({harness:null},execution),/must be a string/);
 control.abort();await assert.rejects(tool.execute({harness:'claude-code'},execution),/CANCELLED_BEFORE_QUERY/);assert.equal(reads,0);
});
