// INPUT: An already-authorized registered session directory.
// OUTPUT: Actual Git working-tree root or explicit unknown, never an inferred cwd alias.
// POS: Read-only topology collector; no hooks, configuration writes, shell or model.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {realpath} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
const run=promisify(execFile);
export async function readGitWorktree(directory:string):Promise<string|null>{
 if(typeof directory!=='string'||!isAbsolute(directory)||directory.includes('\0'))return null;
 try{
  const {stdout}=await run('/usr/bin/git',['--no-optional-locks','-C',directory,'rev-parse','--show-toplevel'],{env:{},encoding:'utf8'});
  return await realpath(stdout.replace(/\r?\n$/,''));
 }catch{return null;}
}
