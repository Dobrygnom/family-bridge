import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AtomicStore } from "../electron/store.js";
import { createUpdateCheckpoint, latestUpdateCheckpoint, recoverMissingCheckpointData } from "../electron/update-checkpoint.js";

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
    const patch=await recoverMissingCheckpointData(dir,damaged);
    const restored=await store.update(patch);
    assert.equal(restored.reports.length,1);
    assert.match(await readFile(restored.reports[0],"utf8"),/Незаменимый текст/);
    assert.equal(restored.conversationTranscripts.live.messages[0].text,"Черновик");
    assert.equal(restored.conversationParents.live,id);
    assert.ok(await latestUpdateCheckpoint(dir));
  } finally { await rm(dir,{recursive:true,force:true}); }
});
