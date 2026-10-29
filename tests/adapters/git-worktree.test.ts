// INPUT: New synthetic Git repositories and linked worktrees in private temporary folders.
// OUTPUT: Verified worktree roots and unknown results for absent or invalid directories.
// POS: Read-only Git metadata tests; no user repositories, files or credentials.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
const run=promisify(execFile);const url=new URL('../../src/adapters/git-worktree.ts',import.meta.url).href;
async function fixture(t:any){const root=await realpath(await mkdtemp(join(tmpdir(),'ms-git-')));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
test('ordinary and linked worktree paths come from actual Git topology',async t=>{
 const root=await fixture(t);const repository=join(root,'repo'),linked=join(root,'linked');await mkdir(repository);
 await run('/usr/bin/git',['init','--quiet',repository]);
 await run('/usr/bin/git',['-C',repository,'-c','user.name=Test','-c','user.email=test@example.invalid','-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','commit','--quiet','--allow-empty','-m','test: synthetic repository']);
 await run('/usr/bin/git',['-C',repository,'worktree','add','--quiet','-b','synthetic-linked',linked]);
 const {readGitWorktree}=await import(url);
 assert.equal(await readGitWorktree(repository),repository);assert.equal(await readGitWorktree(linked),linked);
 const nested=join(linked,'nested');await mkdir(nested);assert.equal(await readGitWorktree(nested),linked);
});
test('non-Git, missing, relative and bare repositories remain unknown',async t=>{
 const root=await fixture(t);const {readGitWorktree}=await import(url);
 for(const directory of [root,join(root,'missing'),'relative','/bad\0path'])assert.equal(await readGitWorktree(directory),null);
 const bare=join(root,'bare');await run('/usr/bin/git',['init','--quiet','--bare',bare]);assert.equal(await readGitWorktree(bare),null);
});
