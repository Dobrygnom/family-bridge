import assert from "node:assert/strict";
import test from "node:test";
import { AutomaticUpdate } from "../electron/automatic-update.js";

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
