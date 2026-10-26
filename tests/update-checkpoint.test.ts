import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AtomicStore } from "../electron/store.js";
import { completeUpdateCheckpointRecovery, createUpdateCheckpoint, latestUpdateCheckpoint, recoverMissingCheckpointData, updateCheckpointDiagnostics } from "../electron/update-checkpoint.js";

test("verified update checkpoint restores a report and conversation metadata missing after restart", async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),"fb-update-checkpoint-"));
  try {
    const reports=path.join(dir,"reports"); await mkdir(reports);
    const report=path.join(reports,"conversation.json"), id="conversation-id";
    await writeFile(report,JSON.stringify({conversationId:id,topic:"Тема",messages:[{from:"dima",text:"Незаменимый текст"}]}));
    const store=new AtomicStore(dir);
    const before=await store.update({reports:[report],conversationTranscripts:{live:{topic:"Тема",messages:[{from:"dima",text:"Черновик"}]}},conversationParents:{live:id}});
    await createUpdateCheckpoint(dir,before,"1.2.51");
    const damaged=await store.update({reports:[],conversationTranscripts:{},conversationParents:{}});
    const recovery=await recoverMissingCheckpointData(dir,damaged);
    const restored=await store.update(recovery.state);
    assert.equal(restored.reports.length,1);
    assert.match(await readFile(restored.reports[0],"utf8"),/Незаменимый текст/);
    assert.equal(restored.conversationTranscripts.live.messages[0].text,"Черновик");
    assert.equal(restored.conversationParents.live,id);
    assert.ok(await latestUpdateCheckpoint(dir));
    assert.ok(recovery.checkpointRoot);
    assert.deepEqual(await updateCheckpointDiagnostics(dir),{available:true,createdAt:(JSON.parse(await readFile(path.join(recovery.checkpointRoot!,"manifest.json"),"utf8"))).createdAt,sourceVersion:"1.2.51",reports:1,files:0,reconciled:false});
    await new Promise(resolve=>setTimeout(resolve,5));
    const newestRoot=await createUpdateCheckpoint(dir,restored,"1.2.52");
    await completeUpdateCheckpointRecovery(newestRoot,"1.2.53");
    assert.equal((await updateCheckpointDiagnostics(dir)).reconciled,true);
    const removed=await store.update({reports:[],conversationTranscripts:{},conversationParents:{}});
    const noResurrection=await recoverMissingCheckpointData(dir,removed);
    assert.deepEqual(noResurrection.state,{});
    assert.equal(noResurrection.checkpointRoot,undefined);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test("update checkpoint restores missing or corrupt context files without overwriting valid newer data", async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),"fb-update-profile-checkpoint-"));
  try {
    const memory=path.join(dir,"psychologist-memory"); await mkdir(memory,{recursive:true});
    await writeFile(path.join(memory,"context-source.json"),JSON.stringify({id:"source-before"}));
    await writeFile(path.join(memory,"context-analysis.json"),JSON.stringify({status:"ready",topics:["saved"]}));
    await writeFile(path.join(memory,"intake.json"),JSON.stringify({version:1,messages:["saved"]}));
    await writeFile(path.join(memory,"style-samples.jsonl"),"saved sample\n");
    const state=await new AtomicStore(dir).read();
    await createUpdateCheckpoint(dir,state,"2.1.19");
    await writeFile(path.join(memory,"context-source.json"),JSON.stringify({id:"newer-source"}));
    await writeFile(path.join(memory,"context-analysis.json"),"{broken");
    await rm(path.join(memory,"intake.json"));
    await writeFile(path.join(memory,"style-samples.jsonl"),"newer sample\n");

    const recovery=await recoverMissingCheckpointData(dir,state);
    assert.deepEqual(JSON.parse(await readFile(path.join(memory,"context-source.json"),"utf8")),{id:"newer-source"});
    assert.deepEqual(JSON.parse(await readFile(path.join(memory,"context-analysis.json"),"utf8")),{status:"ready",topics:["saved"]});
    assert.deepEqual(JSON.parse(await readFile(path.join(memory,"intake.json"),"utf8")),{version:1,messages:["saved"]});
    assert.equal(await readFile(path.join(memory,"style-samples.jsonl"),"utf8"),"newer sample\n");
    assert.deepEqual(recovery.restoredFiles.sort(),["psychologist-memory/context-analysis.json","psychologist-memory/intake.json"]);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test("update checkpoint restores all durable queues and pairing after a reset state", async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),"fb-update-full-state-"));
  try {
    const store=new AtomicStore(dir);
    const before=await store.update({ owner:"katya", identityConfigured:true, onboardingComplete:true, displayName:"Configured", remote:{pairId:"pair",encryptionSecret:"secret"},
      pendingTopics:["pending"], pairTopics:["catalog"], activeTopics:["active"], pendingManualReplies:[{id:"manual",conversationId:"c",topic:"T",createdAt:"now",nextSequence:2,transcript:[{from:"dima",text:"saved"}],text:"draft"}],
      continuations:{cont:{parentReportId:"p",topic:"T",pairId:"pair",instruction:"continue",history:[{from:"dima",text:"saved"}],status:"preview",preparedMessage:"draft"}},
      incomingDeliveries:{delivery:{envelope:{id:"delivery",pair_id:"pair",sender_id:"sender",recipient_id:"recipient",sender_agent:"dima",conversation_id:"c",sequence_number:1,payload:{kind:"dialogue",text:"encrypted"},status:"pending",created_at:"now"}}} });
    await createUpdateCheckpoint(dir,before,"2.1.19");
    const emptyDir=await mkdtemp(path.join(os.tmpdir(),"fb-update-empty-state-"));
    try {
      const empty=await new AtomicStore(emptyDir).read();
      await writeFile(path.join(dir,"state.json"),JSON.stringify(empty));
      const resetStore=new AtomicStore(dir);
      const recovery=await recoverMissingCheckpointData(dir,await resetStore.read());
      const restored=await resetStore.update(recovery.state);
      assert.equal(restored.owner,"katya");
      assert.equal(restored.remote?.pairId,"pair");
      assert.deepEqual(restored.pendingTopics,["pending"]);
      assert.equal(restored.pendingManualReplies[0].text,"draft");
      assert.equal(restored.continuations.cont.preparedMessage,"draft");
      assert.ok(restored.incomingDeliveries.delivery);
    } finally { await rm(emptyDir,{recursive:true,force:true}); }
  } finally { await rm(dir,{recursive:true,force:true}); }
});
