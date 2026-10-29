// INPUT: Isolated registry fixtures and a mocked fixed ps response.
// OUTPUT: Exact registered-process consistency and fail-closed file regressions.
// POS: Offline App registry evidence tests; no user registry or process inspection.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, symlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import childProcess from 'node:child_process';
import { verifyAppRegistry } from '../../src/bridge/app-registry.ts';

test('fixed authenticated PID selects one registry and exact UTC C ps output', t => {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'app-registry-')));
  const sessions=join(root,'sessions'); mkdirSync(sessions,{mode:0o755});
  const socketPath=join(root,'native.sock'); writeFileSync(socketPath,'');
  const path=join(sessions,'42.json'); const procStart='Sun Oct 18  01:02:03 2026';
  const entry={pid:42,sessionId:'native',procStart,messagingSocketPath:socketPath,unknown:{ignored:true}};
  const options={configRoot:root,cliPid:42,nativeSessionId:'native',socketPath};
  writeFileSync(path,JSON.stringify(entry),{mode:0o644});
  let calls=0; let behavior: () => void = () => {};
  t.mock.method(childProcess,'execFileSync',(file: unknown,argv: unknown,opts: unknown) => {
    calls++; behavior(); assert.equal(file,'/bin/ps'); assert.deepEqual(argv,['-o','lstart=','-p','42']);
    assert.deepEqual(opts,{encoding:'utf8',env:{LC_ALL:'C',TZ:'UTC',PATH:'/usr/bin:/bin'}});
    return ' '+procStart+'\n';
  });
  try {
    assert.equal(verifyAppRegistry(options),undefined); assert.equal(calls,1);
    for(const changed of [{pid:43},{sessionId:'wrong'},{procStart:procStart.replace('  ',' ')},{messagingSocketPath:'/missing'}, {procStart:null}]) {
      writeFileSync(path,JSON.stringify({...entry,...changed}));
      assert.throws(()=>verifyAppRegistry(options),/^Error: APP_REGISTRY_UNAVAILABLE$/);
    }
    writeFileSync(path,JSON.stringify(entry)); chmodSync(path,0o666);
    assert.throws(()=>verifyAppRegistry(options),/^Error: APP_REGISTRY_UNAVAILABLE$/);
    chmodSync(path,0o644); chmodSync(sessions,0o777);
    assert.throws(()=>verifyAppRegistry(options),/^Error: APP_REGISTRY_UNAVAILABLE$/);
    chmodSync(sessions,0o755);
    behavior=()=>{const replacement=path+'.replacement';writeFileSync(replacement,JSON.stringify(entry),{mode:0o644});renameSync(replacement,path);};
    assert.throws(()=>verifyAppRegistry(options),/^Error: APP_REGISTRY_UNAVAILABLE$/);
    behavior=()=>{throw new Error('PRIVATE PROCESS ERROR');};
    assert.throws(()=>verifyAppRegistry(options),/^Error: APP_REGISTRY_UNAVAILABLE$/);
    behavior=()=>{};
    writeFileSync(path,'{private invalid json');
    assert.throws(()=>verifyAppRegistry(options),/^Error: APP_REGISTRY_UNAVAILABLE$/);
    writeFileSync(path,JSON.stringify(entry));
    for(const invalid of [{...options,cliPid:0},{...options,configRoot:root+'/../'+root.split('/').at(-1)},{...options,socketPath:'relative'}]) {
      assert.throws(()=>verifyAppRegistry(invalid),/^Error: APP_REGISTRY_UNAVAILABLE$/);
    }
    rmSync(path); symlinkSync(socketPath,path);
    assert.throws(()=>verifyAppRegistry(options),/^Error: APP_REGISTRY_UNAVAILABLE$/);
    rmSync(path);
    assert.throws(()=>verifyAppRegistry(options),/^Error: APP_REGISTRY_UNAVAILABLE$/);
  } finally {rmSync(root,{recursive:true,force:true});}
});
