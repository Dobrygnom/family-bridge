import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Diagnostics } from '../electron/diagnostics.js';

test('diagnostics identify the physical saved files without recording their contents',()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'fb-diag-test-'));
  try {
    const d=new Diagnostics(dir,path.join(dir,'fallback'));
    writeFileSync(path.join(dir,'state.json'),JSON.stringify({onboardingComplete:true,reports:['private-report'],encryptionSecret:'secret-never-log'}));
    d.snapshotProfile(dir,'test');
    d.record('test',{version:'1.2.13',prompt:'private-prompt',token:'private-token'} as any);
    const log=readFileSync(d.file,'utf8'); const entries=log.trim().split('\n').map(s=>JSON.parse(s)); const state=entries.find(e=>e.fileKind==='state');
    assert.equal(state.onboarding,true);assert.equal(state.reports,1);assert.match(state.sha256,/^[a-f0-9]{64}$/);assert.equal(typeof state.device,'string');assert.equal(typeof state.inode,'string');
    assert.equal(entries.find(e=>e.fileKind==='analysis').code,'ENOENT');assert.doesNotMatch(log,/secret-never-log|private-prompt|private-token|private-report/);
    assert.ok(readFileSync(d.fallbackFile,'utf8').includes(state.sha256));
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('diagnostics retain evidence outside an unwritable profile and never block startup',()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'fb-diag-test-'));
  try {
    const profile=path.join(dir,'profile');mkdirSync(profile);writeFileSync(path.join(profile,'diagnostics'),'not-a-directory');
    const d=new Diagnostics(profile,path.join(dir,'fallback'));
    assert.doesNotThrow(()=>d.record('startup.begin',{version:'1.2.13'}));
    const entry=JSON.parse(readFileSync(d.fallbackFile,'utf8').trim());assert.ok(entry.primaryLogCode);assert.equal(entry.primaryLogPath,d.file);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
