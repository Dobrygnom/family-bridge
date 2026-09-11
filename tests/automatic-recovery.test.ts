import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {BackgroundService} from "../electron/background-service.js";
import {AtomicStore} from "../electron/store.js";
import {AutomaticUpdate} from "../electron/automatic-update.js";
const answer={status:"continue",message_to_peer:"Prepared safe reply",owner_question:"",shared_summary:"",comparison_summary:"",topics:[],private_report:""};
async function fixture(){
  const dir=await mkdtemp(path.join(os.tmpdir(),'fb-auto-recovery-'));
  const store=new AtomicStore(dir);
  await store.update({identityConfigured:true,onboardingComplete:true,remote:{pairId:'pair',encryptionSecret:'test',counterpartPersonId:'partner'}});
  const service=new BackgroundService(dir,process.cwd(),store,()=>null,undefined,{backgroundTasks:false});
  const sent:any[]=[];
  const transport={pairState:async()=>({id:'pair',owner_id:'one',partner_id:'two'}),identity:async()=>'one',send:async(value:any)=>{sent.push(value);return 'sent';}};
  (service as any).remote=transport;
  (service as any).refreshHealth=()=>{};
  (service as any).localRemoteAgent=()=>({start:async()=>answer});
  return {dir,store,service,transport,sent};
}
test("approval before choosing the connected person is queued on confirmation and after restart",async()=>{
  const f=await fixture();
  try{
    await (f.service as any).writeContextSource({id:'source',status:'ready'});
    await (f.service as any).writeContextAnalysis({sourceId:'source',analysisVersion:1,status:'ready',people:[{id:'partner',label:'Partner'}],topics:[{id:'t',title:'Approved topic',approved:true,discussWithPersonId:'partner',aboutPersonIds:['partner'],reason:'Context'}]});
    await f.service.completeOnboarding('partner');
    assert.deepEqual((await f.store.read()).pendingTopics,['Approved topic']);
    await f.store.update({pendingTopics:[]});
    await f.service.start();
    assert.deepEqual((await f.store.read()).pendingTopics,['Approved topic']);
  }finally{await rm(f.dir,{recursive:true,force:true});}
});
test("lost send response reuses a persisted conversation id and prepared reply, including after restart",async()=>{
  const f=await fixture();let generated=0;
  try{
    (f.service as any).localRemoteAgent=()=>({start:async()=>{generated++;return answer;}});
    f.transport.send=async input=>{f.sent.push(input);throw Error('lost HTTP response');};
    await assert.rejects((f.service as any).startRemoteConversation('Topic'));
    const saved=await f.store.read();const id=Object.keys(saved.topicLaunches)[0];
    const restarted=new BackgroundService(f.dir,process.cwd(),f.store,()=>null,undefined,{backgroundTasks:false});
    (restarted as any).remote={...f.transport,send:async(input:any)=>{f.sent.push(input);return 'same-server-id';}};
    (restarted as any).localRemoteAgent=()=>assert.fail('Do not generate the first reply twice');
    await (restarted as any).startRemoteConversation('Topic');
    assert.equal(generated,1);assert.equal(f.sent[0].idempotencyKey,f.sent[1].idempotencyKey);
    assert.equal((await f.store.read()).topicLaunches[id].status,'waiting');
    assert.equal((await f.store.read()).conversationTranscripts[id].messages.length,1);
  }finally{await rm(f.dir,{recursive:true,force:true});}
});
test("automatic update waits for active workers but does not need a conversation to finish",async()=>{
  const f=await fixture();try{
    (f.service as any).remoteWorkers.set('busy',Promise.resolve());assert.equal(await f.service.prepareForUpdate(),false);
    (f.service as any).remoteWorkers.clear();
    await f.store.update({activeTopics:['Waiting for peer'],conversationTranscripts:{live:{topic:'Waiting for peer',messages:[{from:'dima',text:'sent'}]}}});
    assert.equal(await f.service.prepareForUpdate(),true);
    assert.equal((await f.store.read()).conversationTranscripts.live.messages.length,1);
    f.service.cancelPreparedUpdate();
  }finally{await rm(f.dir,{recursive:true,force:true});}
});

test("update claims a pause while polling is busy and prevents the next timer from starving installation", async()=>{
  const f=await fixture(); let finish!:()=>void, reached!:()=>void, polls=0, installs=0;
  const entered=new Promise<void>(resolve=>{reached=resolve;});
  const response=new Promise<null>(resolve=>{finish=()=>resolve(null);});
  const service=f.service as any;
  service.options.backgroundTasks=true;
  service.beginPeerVersionCheck=()=>{};
  service.remote={...f.transport,claimNext:async()=>{polls++;reached();return response;}};
  const gate=new AutomaticUpdate({canInstall:()=>true,prepare:()=>f.service.prepareForUpdate(),install:async()=>{installs++;},resume:()=>f.service.cancelPreparedUpdate(),failed:()=>assert.fail()});
  try {
    const first=service.pumpRemote(); await entered;
    gate.ready(); await gate.tick();
    assert.equal(installs,0);
    assert.equal(f.service.updateDiagnostics().quiescing,true);
    assert.ok(f.service.updateDiagnostics().blockers.some(b=>b.operation==='remote_poll'));
    finish(); await first;
    // Reproduce the production ordering: inbox timer fires BEFORE updater.
    await service.pumpRemote(); await gate.tick();
    assert.equal(polls,1,'No new poll after the update has requested a pause');
    assert.equal(installs,1,'Installation completes without any quit or manual retry');
    f.service.cancelPreparedUpdate();
    await service.pumpRemote(); assert.equal(polls,2,'A cancelled update resumes polling');
  } finally {finish();await rm(f.dir,{recursive:true,force:true});}
});

test("an inbox read that finishes after quiescing cannot start another model worker",async()=>{
  const f=await fixture();
  try {
    await f.store.update({incomingDeliveries:{pending:{envelope:{id:'pending',conversation_id:'c',sequence_number:1} as any}}});
    const service=f.service as any;
    service.processIncomingDialogue=()=>assert.fail('No new generation during update');
    const draining=service.drainRemoteInbox();
    await f.service.prepareForUpdate();
    await draining;
    assert.equal(Object.keys((await f.store.read()).incomingDeliveries).length,1,'Deferred delivery stays durable');
  }finally{await rm(f.dir,{recursive:true,force:true});}
});

test("explicit refresh reads the selected chat directly without listing unrelated tasks",async()=>{
  const f=await fixture();let syncs=0;
  try{
    const service=f.service as any;
    await service.writeContextSource({id:'selected-chat',source:'chatgpt',status:'error',messageCount:578,lastSyncedAt:new Date().toISOString()});
    service.listContextThreads=()=>assert.fail('Refreshing a known chat must not enumerate every task');
    service.syncContext=async()=>{syncs++;};
    await f.service.checkContextForUpdates(true);assert.equal(syncs,1);
  }finally{await rm(f.dir,{recursive:true,force:true});}
});

test("an empty read never overwrites previously saved source messages",async()=>{
  const f=await fixture();
  try{
    const service=f.service as any;
    await service.writeContextSource({id:'selected-chat',source:'chatgpt',status:'ready',messageCount:578,lastSyncedAt:new Date().toISOString()});
    service.readChatGptMessages=async()=>[];
    await assert.rejects(f.service.syncContext(),{code:'CODEX_DESKTOP_PROTOCOL'});
    assert.equal(service.readContextSource().messageCount,578);
    assert.equal(service.contextSyncing,false);
  }finally{await rm(f.dir,{recursive:true,force:true});}
});

test("automatic work starts only our selected topics and does not duplicate a running launch", async()=>{
  const f=await fixture();
  try {
    (f.service as any).options.backgroundTasks=true;
    await f.store.update({pendingTopics:['Our topic','Peer topic'],topicSources:{'Our topic':['local'],'Peer topic':['peer']}});
    await (f.service as any).automaticWork();
    await (f.service as any).automaticWork();
    await Promise.all((f.service as any).launchPromises.values());
    await (f.service as any).automaticWork();
    assert.equal(f.sent.length,1);
    assert.equal(f.sent[0].payload.topic,'Our topic');
    assert.deepEqual((await f.store.read()).pendingTopics,['Peer topic']);
  } finally {await rm(f.dir,{recursive:true,force:true});}
});
