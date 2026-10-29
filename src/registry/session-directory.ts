// INPUT: Trusted registered descriptors, live endpoint verification and scoped metadata readers.
// OUTPUT: Fresh platform-filtered immutable metadata records; obsolete queries and retired endpoints are dropped.
// POS: Directory composition only; no registration authority, message dispatch or history enumeration.
import {type Endpoint,type Harness,parseEndpoint} from '../protocol/message.ts';
import {createMetadataRegistry,type SessionMetadata,type MetadataRecord} from './metadata.ts';
export type SessionDescriptor=Readonly<{endpoint:Endpoint;cwd:string|null}>;
type Options=Readonly<{describe:(harness:Harness)=>Promise<readonly SessionDescriptor[]>;
 verifyEndpoint:(endpoint:Endpoint)=>Promise<void>;readMetadata:(entry:SessionDescriptor)=>Promise<SessionMetadata>}>;
export function createSessionDirectory(options:Options){
 const sources=Object.freeze({...options});
 const registry=createMetadataRegistry({verify:sources.verifyEndpoint});
 let counter=0n;let tickets=new Map<Harness,bigint>();let observed=new Map<Harness,ReadonlySet<string>>();
 const current=(harness:Harness,ticket:bigint)=>{if(tickets.get(harness)!==ticket)throw new Error('STALE_METADATA_QUERY');};
 return Object.freeze({async list(harness:Harness):Promise<readonly MetadataRecord[]>{
  if(!['claude-code','dsh','codex'].includes(harness))throw new Error('INVALID_METADATA_HARNESS');
  const ticket=++counter;tickets=new Map([...tickets,[harness,ticket]]);
  try{
   const originals=await sources.describe(harness);current(harness,ticket);
   const entries=originals.map(entry=>Object.freeze({endpoint:parseEndpoint(entry.endpoint),cwd:entry.cwd}));
   if(entries.some(entry=>entry.endpoint.harness!==harness))throw new Error('INVALID_METADATA_DESCRIPTOR');
   const present=new Set(entries.map(entry=>entry.endpoint.endpointId));
   for(const id of observed.get(harness)??[])if(!present.has(id))registry.remove(id);
   observed=new Map([...observed,[harness,present]]);
   for(const entry of entries){
    const metadata=await sources.readMetadata(entry);current(harness,ticket);
    await registry.observe(entry.endpoint,metadata);current(harness,ticket);
   }
   const result=await registry.list(harness);current(harness,ticket);return result;
  }catch(error){
   if(error instanceof Error&&['STALE_METADATA_QUERY','INVALID_METADATA_DESCRIPTOR'].includes(error.message))throw error;
   throw new Error('METADATA_QUERY_FAILED');
  }
 }});
}
