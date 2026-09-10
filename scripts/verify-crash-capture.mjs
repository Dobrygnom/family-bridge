import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const electron = createRequire(import.meta.url)('electron');
async function dumps(directory) {
  const result = [];
  for (const entry of await readdir(directory,{withFileTypes:true}).catch(()=>[])) {
    const file=path.join(directory,entry.name);
    if(entry.isDirectory())result.push(...await dumps(file));
    else if(entry.name.endsWith('.dmp'))result.push(file);
  }
  return result;
}
for (const mode of ['main','renderer']) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'fb-crash-smoke-'));
  const env={...process.env}; delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(electron,[fileURLToPath(new URL('./crash-smoke-child.cjs',import.meta.url)),directory,mode],{env,windowsHide:true,stdio:'ignore'});
  const exit=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill();reject(Error('Isolated crash test timed out'));},20000);
    child.on('error',error=>{clearTimeout(timer);reject(error)});
    child.on('exit',(code,signal)=>{clearTimeout(timer);resolve({code,signal})});
  });
  let files=[];const deadline=Date.now()+10000;
  while(Date.now()<deadline){files=await dumps(path.join(directory,'diagnostics/crashes'));if(files.length)break;await new Promise(ok=>setTimeout(ok,200))}
  assert.ok(files.length,`${mode}: no crash dump (${JSON.stringify(exit)})`);
  const marker=JSON.parse(await readFile(path.join(directory,'diagnostics/last-run.json'),'utf8'));
  assert.equal(marker.cleanExit,mode==='renderer','Normal app exit and main process crash must be distinguishable');
  for(const file of files){const data=await readFile(file);assert.equal(data.subarray(0,4).toString(),'MDMP');assert.ok((await stat(file)).size>1024)}
  console.log(JSON.stringify({mode,verified:true,dumps:files.length,directory,exit}));
}
