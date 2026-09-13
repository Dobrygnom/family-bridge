import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BackgroundService } from "../electron/background-service.js";
import { AtomicStore } from "../electron/store.js";

async function fixture() {
  const dir=await mkdtemp(path.join(os.tmpdir(),"fb-maintenance-"));
  const store=new AtomicStore(dir), id=randomUUID(), report=path.join(dir,"report.json"), sent:any[]=[];
  await writeFile(report,JSON.stringify({conversationId:id,pairId:"pair",topic:"Проверка",messages:[
    {from:"dima",text:"Первое"},{from:"katya",text:"Ответ"},{from:"dima",text:"Повторить отсюда"}
  ]}));
  await store.update({owner:"dima",displayName:"Дмитрий",identityConfigured:true,onboardingComplete:true,reports:[report],pairTopics:["Проверка"],activeTopics:["Проверка"],remote:{pairId:"pair",encryptionSecret:"secret",peerVersion:"1.2.44"}});
  const service=new BackgroundService(dir,process.cwd(),store,()=>null,undefined,{backgroundTasks:false,appVersion:"1.2.44"});
  (service as any).remote={pairState:async()=>({id:"pair",owner_id:"me",partner_id:"peer"}),identity:async()=>"me",send:async(value:any)=>{sent.push(value);return "sent";}};
  return {dir,store,id,report,sent,service,cleanup:async()=>{await new Promise(resolve=>setTimeout(resolve,50));await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:20});}};
}

test("diagnostic deletion is idempotent, tombstones late delivery and removes the topic",async()=>{
  const f=await fixture();
  try {
    const first=await f.service.deleteConversation(f.id);
    assert.equal(first.existed,true);
    const state=await f.store.read();
    assert.deepEqual(state.reports,[]); assert.ok(state.ignoredConversationIds.includes(f.id));
    assert.ok(!state.pairTopics.includes("Проверка"));
    await assert.rejects(readFile(f.report,"utf8"));
    assert.equal((await f.service.deleteConversation(f.id)).existed,false);
  }finally{await f.cleanup();}
});

test("restart from a local message creates a new idempotent branch and preserves the prefix",async()=>{
  const f=await fixture();
  try {
    const operationId=randomUUID();
    const result=await f.service.restartConversationFromMessage(f.id,2,operationId);
    assert.equal(result.newConversationId,operationId);
    for(let i=0;i<50&&!f.sent.length;i++) await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(f.sent.length,1);
    const payload=f.sent[0].payload;
    assert.equal(payload.text,"Повторить отсюда");
    assert.deepEqual(payload.continuation.history.map((m:any)=>m.text),["Первое","Ответ"]);
    assert.equal(payload.continuation.parentReportId,f.id);
    const state=await f.store.read();
    assert.equal(state.continuations[operationId].status,"waiting");
    assert.equal(state.conversationParents[operationId],f.id);
    assert.equal((await f.service.restartConversationFromMessage(f.id,2,operationId)).repeated,true);
    assert.equal(f.sent.length,1);
  }finally{await f.cleanup();}
});
