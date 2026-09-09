import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { AutomaticUpdate } from "../electron/automatic-update.js";

test("desktop activity outside Family Bridge does not postpone installation", () => {
  const main = readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8");
  assert.doesNotMatch(main, /getSystemIdleTime/);
  assert.match(main, /activeIpc === 0/);
  assert.match(main, /!rendererUpdateBlocked/);
  assert.match(main, /service\.prepareForUpdate\(\)/);
});

test("automatic installation waits for dictation, editing and background work without confirmations", async () => {
  let safe=false, idle=false, installs=0, preparations=0;
  const updater=new AutomaticUpdate({canInstall:()=>safe,prepare:async()=>{preparations++;return idle;},install:async()=>{installs++;},resume:()=>{},failed:()=>assert.fail()});
  updater.ready(); await updater.tick(); assert.equal(preparations,0);
  safe=true; await updater.tick(); assert.equal(installs,0);
  idle=true; await Promise.all([updater.tick(),updater.tick()]); assert.equal(installs,1);
  await updater.tick(); assert.equal(installs,1);
});
test("a failed installation resumes work and retries without a popup", async()=>{
  let now=0,attempts=0,resumes=0,failures=0;
  const updater=new AutomaticUpdate({canInstall:()=>true,prepare:async()=>true,install:async()=>{if(++attempts===1)throw Error('test');},resume:()=>{resumes++;},failed:()=>{failures++;}},()=>now);
  updater.ready(); await updater.tick(); assert.equal(resumes,1); assert.equal(failures,1);
  await updater.tick(); assert.equal(attempts,1);
  now=60000; await updater.tick(); assert.equal(attempts,2);
});
test("input becoming busy during the save barrier cancels the restart",async()=>{
  let safe=true,resumes=0;
  const updater=new AutomaticUpdate({canInstall:()=>safe,prepare:async()=>{safe=false;return true;},install:async()=>assert.fail(),resume:()=>{resumes++;},failed:()=>assert.fail()});
  updater.ready(); await updater.tick(); assert.equal(resumes,1);
});

test("update now rejects an undownloaded update and bypasses retry cooldown after a failure", async () => {
  let attempts=0;
  const gate=new AutomaticUpdate({canInstall:()=>true,prepare:async()=>true,install:async()=>{if(++attempts===1)throw Error('retry');},resume:()=>{},failed:()=>{}},()=>0);
  assert.throws(()=>gate.requestNow(),/не скачано/);
  gate.ready(); await gate.tick(); assert.equal(attempts,1);
  await gate.tick(); assert.equal(attempts,1);
  gate.requestNow(); await gate.tick(); assert.equal(attempts,2);
  assert.throws(()=>gate.requestNow(),/не скачано/);
});

test("update now reports blockers, keeps safety barriers, and installs automatically when released",async()=>{
  let safe=false, prepared=false, installed=0;
  const waiting:string[]=[];
  const gate=new AutomaticUpdate({canInstall:()=>safe,prepare:async()=>prepared,install:async()=>{installed++;},resume:()=>{},failed:()=>assert.fail(),waiting:reason=>waiting.push(reason)});
  gate.ready(); gate.requestNow(); await gate.tick();
  assert.deepEqual(waiting,['activity']); assert.equal(installed,0);
  safe=true; await gate.tick(); assert.deepEqual(waiting,['activity','background']);
  prepared=true; await Promise.all([gate.tick(),gate.tick()]); assert.equal(installed,1);
  gate.ready(); gate.cancel(); await gate.tick(); assert.equal(installed,1);
});
