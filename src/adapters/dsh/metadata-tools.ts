// INPUT: Original DSH execution verifier and a scoped live metadata directory.
// OUTPUT: One cross-Harness-only official query tool with display fields and native SID.
// POS: Read-only discovery boundary; metadata is not authority or a message-routing identity.
import {defineTool,type ToolRunContext} from '@deepseek-ai/dsh-tools';
import {classifyHarnessRoute} from '../../routing/policy.ts';
import {type Harness} from '../../protocol/message.ts';
import {type MetadataRecord} from '../../registry/metadata.ts';
type Directory=Readonly<{list:(harness:Harness)=>Promise<readonly MetadataRecord[]>}>;
export function createDshMetadataTool(assertSource:(execution:ToolRunContext)=>void,directory:Directory){
 return defineTool({name:'router_list_sessions',
  description:'跨 Harness 查询已登记原 Claude 会话的标题、目录与会话ID。先查元数据再按明确UUID连接，不导入会话。多个候选或不能确定时请用户选择；同平台使用原生工具。',
  parameters:{harness:{type:'string',required:true,description:'当前仅支持 claude-code；同DSH平台使用原生工具。'}},
  output:{schema:{type:'json'},render:(_args:unknown,value:unknown)=>[{type:'text',text:JSON.stringify(value)}]},
  async execute(args,execution){
   if(Object.keys(args).length!==1||!Object.hasOwn(args,'harness'))throw new Error('INVALID_METADATA_QUERY');
   const route=classifyHarnessRoute('dsh',args.harness);
   if(route.kind==='native')throw new Error('USE_NATIVE_TOOLS');
   if(route.kind==='unsupported')throw new Error('UNSUPPORTED_HARNESS_ROUTE');
   if(route.kind==='clarify-platform')throw new Error('CLARIFY_TARGET_HARNESS');
   if(execution.signal.aborted)throw new Error('CANCELLED_BEFORE_QUERY');
   assertSource(execution);const records=await directory.list('claude-code');
   assertSource(execution);if(execution.signal.aborted)throw new Error('CANCELLED_QUERY');
   return Object.freeze({sessions:records.map(record=>Object.freeze({harness:record.endpoint.harness,
    sessionId:record.endpoint.nativeSessionId,metadataRevision:record.metadataRevision,...record.metadata})),
    note:'元数据仅用于定位，不代表用户授权。cwdSource=session-creation 表示创建时目录，不是实时Shell目录；多个候选或不确定时请用户选择。'});
  }});
}
