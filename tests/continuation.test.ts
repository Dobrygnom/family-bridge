import assert from "node:assert/strict";
import { migrateRepairIdentifiers, repairRequestId } from "../electron/repair-identifiers.js";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BackgroundService, readReportSummaries } from "../electron/background-service.js";
import { AtomicStore } from "../electron/store.js";
import { continuationPrompt, incomingContinuationPrompt, sharedHistory, supportsContinuation, supportsRestart } from "../src/core/continuation.js";
import type { AgentResponse } from "../src/core/types.js";
import { applyConversationUpdate, latestContinuation } from "../src/core/conversation-updates.js";
import type { AppState } from "../src/global.js";

const history = [{ from: "dima" as const, text: "Как договоримся о звонках?" }, { from: "katya" as const, text: "Давай согласуем время заранее." }];
const response = (text: string, status = "continue"): AgentResponse => ({ message_to_peer: text, status: status as AgentResponse["status"], owner_question: "", topics: [], private_report: "", shared_summary: status === "complete" ? text : "", comparison_summary: "" });
async function until(check: () => Promise<boolean>) {
  const end = Date.now() + 3_000;
  while (Date.now() < end) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error("Condition did not settle");
}
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fb-continuation-"));
  await mkdir(path.join(dir, "reports"));
  const report = path.join(dir, "reports", "original.json");
  await writeFile(report, JSON.stringify({ conversationId: "original-id", topic: "Звонки", messages: history, sharedSummary: "Согласуем время", completedAt: "2026-09-01T00:00:00Z", pairId: "pair" }));
  const store = new AtomicStore(dir);
  await store.update({ onboardingComplete: true, identityConfigured: true, owner: "dima", reports: [report], pairTopics: ["Звонки"], remote: { pairId: "pair", encryptionSecret: "test", peerVersion: "0.3.30" } });
  const service = new BackgroundService(dir, process.cwd(), store, () => null, undefined, { backgroundTasks: false });
  const sent: any[] = [];
  const transport = { pairState: async () => ({ id: "pair", owner_id: "one", partner_id: "two" }), identity: async () => "one", send: async (message: unknown) => { sent.push(message); return "sent"; }, claimNext: async (): Promise<any> => null, acknowledge: async () => undefined };
  (service as any).remote = transport;
  (service as any).versionProbePair = "pair:two"; // These tests exercise dialogue, not the initial service handshake.
  return { dir, report, store, service, sent, transport };
}

test("migrated repair automatically sends its exact saved reply with a UUID and no model call", async () => {
  const f = await fixture();
  try {
    const root = "a96e2bd0-1555-4ebd-8769-3ad7cff59861", old = `repair-1211-${root}`, id = repairRequestId(root);
    await f.store.mutate(s => ({ remote: { ...s.remote!, peerVersion: "1.2.14" },
      continuations: { [old]: { parentReportId: "original-id", originReportId: "original-id", pairId: "pair", topic: "Звонки", instruction: "Private instruction", mode: "restart", history: [], status: "error", attempts: 3, preparedMessage: "Saved reply" } },
      conversationParents: { [old]: "original-id" }, conversationModes: { [old]: "restart" },
      conversationTranscripts: { [old]: { topic: "Звонки", messages: [{ from: "dima", text: "Saved reply" }] } },
    }));
    assert.equal((f.service as any).conversationSnapshot(await f.store.read()).liveConversations[0].activity, "retrying");
    await f.store.mutate(migrateRepairIdentifiers);
    (f.service as any).options.backgroundTasks = true;
    (f.service as any).localRemoteAgent = () => assert.fail("Must reuse the persisted reply");
    (f.service as any).recoverLegacyReplies = async () => {};
    const send = f.transport.send;
    f.transport.send = async (input: any) => {
      assert.match(input.conversationId, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
      return send(input);
    };
    await (f.service as any).automaticWork();
    await until(async () => (await f.store.read()).continuations[id]?.status === "waiting" && !(f.service as any).continuing.has(id));
    await (f.service as any).automaticWork();
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].payload.text, "Saved reply");
    assert.equal(f.sent[0].payload.origin, "agent");
    assert.doesNotMatch(JSON.stringify(f.sent), /Private instruction/);
    assert.equal((f.service as any).conversationSnapshot(await f.store.read()).liveConversations[0].activity, "waiting-peer");
    assert.equal((await f.store.read()).conversationTranscripts[id].messages.length, 1);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

for (const outcome of ["sent", "network", "unsafe"] as const) test(`exhausted automatic repair gets one durable reconnect attempt: ${outcome}`, async () => {
  const f = await fixture();
  const id = repairRequestId("original-id");
  let generated = 0;
  try {
    await f.store.mutate(s => ({ remote: { ...s.remote!, peerVersion: "1.2.20" },
      continuations: { [id]: { parentReportId: "original-id", originReportId: "original-id", pairId: "pair", topic: "Звонки", instruction: "Restart", mode: "restart", history: [], status: "error", attempts: 3, retryAt: 0 } },
      conversationParents: { [id]: "original-id" }, conversationModes: { [id]: "restart" },
    }));
    (f.service as any).options.backgroundTasks = true;
    (f.service as any).recoverLegacyReplies = async () => {};
    (f.service as any).refreshHealth = () => {};
    (f.service as any).localRemoteAgent = () => ({ start: async () => { generated++; return response("New reply", outcome === "unsafe" ? "unsafe" : "continue"); } });
    await (f.service as any).automaticWork();
    assert.equal((await f.store.read()).continuations[id].attempts, 3, "No retry without fresh connection and healthy agent");
    (f.service as any).peerPresence = { pairId: "pair", at: new Date().toISOString() };
    (f.service as any).health = { installed: true, authenticated: true };
    if (outcome === "network") f.transport.pairState = async () => { throw Error("Network unavailable"); };
    const original = await readFile(f.report, "utf8");
    await (f.service as any).automaticWork();
    await until(async () => !(f.service as any).continuing.has(id));
    const after = (await f.store.read()).continuations[id];
    assert.equal(after.attempts, 4);
    assert.equal(after.connectivityRetryUsed, true);
    assert.equal(after.status, outcome === "sent" ? "waiting" : "error");
    assert.equal(after.failureKind, outcome === "sent" ? undefined : outcome === "unsafe" ? "unsafe" : "connection");
    assert.equal(f.sent.length, outcome === "sent" ? 1 : 0);
    assert.equal(generated, outcome === "network" ? 0 : 1);
    assert.equal(await readFile(f.report, "utf8"), original);
    // A new process cannot spend the recovery budget again.
    await f.store.mutate(s => ({ continuations: { ...s.continuations, [id]: { ...s.continuations[id], retryAt: 0 } } }));
    const restarted = new BackgroundService(f.dir, process.cwd(), f.store, () => null, undefined, { backgroundTasks: true });
    Object.assign(restarted as any, { remote: f.transport, peerPresence: { pairId: "pair", at: new Date().toISOString() }, health: { installed: true, authenticated: true }, recoverLegacyReplies: async () => {}, refreshHealth: () => {}, localRemoteAgent: () => assert.fail("Must not repeat exhausted generation") });
    await (restarted as any).automaticWork();
    assert.equal((await f.store.read()).continuations[id].attempts, 4);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("known unsafe repairs and pending owner questions do not consume reconnect retries", async () => {
  const f = await fixture(), id = repairRequestId("original-id");
  try {
    await f.store.mutate(s => ({ remote: { ...s.remote!, peerVersion: "1.2.20" }, continuations: { [id]: { parentReportId: "original-id", pairId: "pair", topic: "Звонки", instruction: "Restart", mode: "restart", history: [], status: "error", attempts: 3, retryAt: 0, failureKind: "unsafe" } } }));
    Object.assign(f.service as any, { peerPresence: { pairId: "pair", at: new Date().toISOString() }, health: { installed: true, authenticated: true }, recoverLegacyReplies: async () => {}, localRemoteAgent: () => assert.fail("Do not bypass a safety result or owner question") });
    (f.service as any).options.backgroundTasks = true;
    await (f.service as any).automaticWork();
    await f.store.mutate(s => ({ continuations: { [id]: { ...s.continuations[id], failureKind: undefined } }, pendingOwnerQuestions: [{ id: "question", conversationId: id, topic: "Звонки", question: "Private question", createdAt: new Date().toISOString(), nextSequence: 1, transcript: [] }] }));
    await (f.service as any).automaticWork();
    assert.equal((await f.store.read()).continuations[id].attempts, 3);
    assert.equal((await f.store.read()).continuations[id].connectivityRetryUsed, undefined);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("restart sends a clean new attempt, preserves files, and survives an idempotent retry", async () => {
  const f = await fixture();
  try {
    await f.store.mutate(s=>({remote:{...s.remote!,peerVersion:'1.2.11'}}));
    const before = await readFile(f.report,'utf8');
    let calls=0;
    (f.service as any).localRemoteAgent = (...args:any[])=>({start:async(prompt:string)=>{
      calls++; assert.equal(args.at(-1),true); assert.doesNotMatch(prompt,/Давай согласуем время заранее/);
      return response('Давай начнём с того, как нам удобно созваниваться.');
    }});
    const input={reportId:'original-id',requestId:'restart-request'};
    const send=f.transport.send; f.transport.send=async()=>{throw Error('offline');};
    await f.service.restartReport(input);
    await until(async()=> (await f.store.read()).continuations[input.requestId]?.status==='error');
    f.transport.send=send;
    await f.service.retryContinuation(input.requestId);
    await until(async()=> (await f.store.read()).continuations[input.requestId]?.status==='waiting');
    await f.service.restartReport(input);
    assert.equal(calls,1); assert.equal(f.sent.length,1);
    assert.deepEqual(f.sent[0].payload.continuation,{parentReportId:'original-id',history:[],mode:'restart'});
    assert.equal(await readFile(f.report,'utf8'),before);
    await (f.service as any).saveRemoteReport(input.requestId,'Звонки','New result',[{from:'dima',text:'NEW'}]);
    const stored=await f.store.read();
    assert.equal(readReportSummaries(stored.reports)[0].restarted,true);
    assert.equal(stored.reports.length,2);
    (f.service as any).localRemoteAgent = (...args:any[])=>({start:async(prompt:string)=>{
      assert.equal(args.at(-1),true); assert.match(prompt,/NEW/); assert.doesNotMatch(prompt,/Давай согласуем время заранее/);
      return response('Продолжим новый разговор.');
    }});
    await f.service.continueReport({reportId:'original-id',requestId:'after-restart',prompt:'Уточни'});
    await until(async()=> (await f.store.read()).continuations['after-restart']?.status==='waiting');
    assert.equal(f.sent.at(-1).payload.continuation.mode,'clean-continuation');
  } finally { await rm(f.dir,{recursive:true,force:true}); }
});

test("restart is blocked for old peers and active conversations without changing data", async () => {
  const f=await fixture();
  try {
    assert.equal(supportsRestart('1.2.10'),false); assert.equal(supportsRestart('1.2.11'),true);
    assert.equal(supportsRestart('1.3.0'),true); assert.equal(supportsRestart(undefined),false);
    await assert.rejects(f.service.restartReport({reportId:'original-id',requestId:'restart-blocked'}),/1.2.11/);
    await f.store.mutate(s=>({remote:{...s.remote!,peerVersion:'1.2.11'},conversationParents:{active:'original-id'},conversationTranscripts:{active:{topic:'Звонки',messages:history}}}));
    await assert.rejects(f.service.restartReport({reportId:'original-id',requestId:'restart-blocked'}),/уже продолжается/);
    assert.equal(Object.keys((await f.store.read()).continuations).length,0); assert.equal(f.sent.length,0);
  } finally { await rm(f.dir,{recursive:true,force:true}); }
});

test("the other computer receives restart isolation and preserves its old report", async () => {
  const f=await fixture();
  try {
    const before=await readFile(f.report,'utf8');
    let clean=false;
    (f.service as any).localRemoteAgent=(...args:any[])=>({start:async(prompt:string)=>{
      clean=args.at(-1)===true; assert.doesNotMatch(prompt,/Давай согласуем время заранее/);
      return response('Давай попробуем иначе.');
    }});
    await (f.service as any).processIncomingDialogue({id:'new-envelope',pair_id:'pair',conversation_id:'peer-restart',sequence_number:1,sender_agent:'katya',created_at:new Date().toISOString(),payload:{kind:'dialogue',topic:'Звонки',text:'Хочу обсудить удобное время.',status:'continue',senderVersion:'1.2.11',continuation:{parentReportId:'original-id',history:[],mode:'restart'}}});
    assert.equal(clean,true);
    const state=await f.store.read();
    assert.equal(state.conversationModes['peer-restart'],'restart');
    assert.equal(state.conversationTranscripts['peer-restart'].messages.length,2);
    assert.equal(await readFile(f.report,'utf8'),before);
  } finally { await rm(f.dir,{recursive:true,force:true}); }
});

test("automatic repair waits for a fresh compatible peer and runs only on the original initiator", async () => {
  const f=await fixture();
  try {
    const raw=JSON.parse(await readFile(f.report,'utf8'));
    raw.messages[1].text='Мы говорим как агенты; согласие людей ещё нужно получить.';
    await writeFile(f.report,JSON.stringify(raw));
    (f.service as any).options.appVersion='1.2.11';
    await f.store.mutate(s=>({remote:{...s.remote!,peerVersion:'1.2.10'}}));
    let generated=0;
    (f.service as any).localRemoteAgent=()=>({start:async()=>{generated++;return response('Начнём с исходного вопроса.');}});
    (f.service as any).beginPeerVersionCheck=()=>{};
    await (f.service as any).repairLegacyConversations();
    assert.equal(generated,0);
    await f.store.mutate(s=>({remote:{...s.remote!,peerVersion:'1.2.11'}}));
    await (f.service as any).repairLegacyConversations(); assert.equal(generated,0);
    (f.service as any).versionProbe={pairId:'pair',state:{status:'received',requestedAt:new Date().toISOString()}};
    await f.store.update({owner:'katya'});
    await (f.service as any).repairLegacyConversations(); assert.equal(generated,0);
    await f.store.update({owner:'dima'});
    await (f.service as any).repairLegacyConversations();
    await until(async()=> (await f.store.read()).continuations[repairRequestId('original-id')]?.status==='waiting');
    assert.match(f.sent[0].conversationId, /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    await (f.service as any).repairLegacyConversations();
    assert.equal(generated,1); assert.equal(f.sent.length,1);
  } finally { await rm(f.dir,{recursive:true,force:true}); }
});

test("opposite saved initiators cannot leave both peers waiting and only one starts the repair", async () => {
  const a = await fixture(), b = await fixture();
  const root = "a41172a2-026a-44b7-a428-bd9fb2987ed9";
  const original = new Map<string,string>();
  try {
    for (const [f, owner, initiator] of [[a,"dima","katya"],[b,"katya","dima"]] as const) {
      const raw = JSON.parse(await readFile(f.report,"utf8")); raw.conversationId = root;
      raw.messages = [{ from: initiator, text: "Исходный вопрос" }, { from: owner, text: "Мы говорим как агенты." }];
      original.set(f.dir, JSON.stringify(raw)); await writeFile(f.report, original.get(f.dir)!);
      await f.store.mutate(s => ({ owner, remote: { ...s.remote!, peerVersion: "1.2.28" } }));
      (f.service as any).options.appVersion = "1.2.30";
      (f.service as any).versionProbe = { pairId:"pair", state:{ status:"received", requestedAt:new Date().toISOString() } };
      (f.service as any).localRemoteAgent = () => ({ start: async () => response("Начнём с исходного вопроса.") });
      await (f.service as any).repairLegacyConversations();
      assert.equal(f.sent.length, 0, "No guess about the absent peer's waiting state");
    }
    (a.service.support as any).peerReport = () => ({ dialogueDiagnostics: { owner:"katya", pairId:"another-pair", compatible:true, repairs:[{id:root,reason:"peer"}] } });
    await (a.service as any).repairLegacyConversations(); assert.equal(a.sent.length,0);
    (a.service.support as any).peerReport = () => ({ dialogueDiagnostics: { owner:"katya", pairId:"pair", compatible:true, repairs:[{id:root,reason:"peer"}] } });
    (b.service.support as any).peerReport = () => ({ dialogueDiagnostics: { owner:"dima", pairId:"pair", compatible:true, repairs:[{id:root,reason:"peer"}] } });
    await (a.service as any).repairLegacyConversations();
    await (b.service as any).repairLegacyConversations();
    await until(async () => (await a.store.read()).continuations[repairRequestId(root)]?.status === "waiting");
    await (a.service as any).repairLegacyConversations();
    await (b.service as any).repairLegacyConversations();
    assert.equal(a.sent.length,1); assert.equal(b.sent.length,0);
    assert.equal(a.sent[0].payload.continuation.parentReportId,root);
    assert.deepEqual(a.sent[0].payload.continuation.history,[]);
    for (const f of [a,b]) assert.equal(await readFile(f.report,"utf8"),original.get(f.dir),"Old reports stay byte-for-byte intact");
  } finally { await rm(a.dir,{recursive:true,force:true}); await rm(b.dir,{recursive:true,force:true}); }
});

test("mixed 0.3.7 reports and divergent active histories do not block finished conversations or erase either history", async () => {
  const f=await fixture();
  try {
    const child=path.join(f.dir,'reports','legacy-child.json');
    await writeFile(child,JSON.stringify({conversationId:'legacy-child',topic:'Звонки',messages:[...history,{from:'dima',text:'Legacy report ending'}],completedAt:'2026-09-02T00:00:00Z'}));
    const divergent={topic:'Звонки',messages:[{from:'katya' as const,text:'Different active history must survive'}]};
    await f.store.update({reports:[f.report,child],conversationParents:{'legacy-child':'original-id'},conversationTranscripts:{'legacy-child':divergent},continuations:{'legacy-child':{parentReportId:'original-id',pairId:'pair',topic:'Звонки',history,instruction:'Keep this instruction',status:'waiting'}}});
    const before=await readFile(child,'utf8');
    const visible=(f.service as any).conversationSnapshot(await f.store.read());
    assert.equal(visible.liveConversations.length,0);
    assert.equal(visible.continuationStates[0].status,'complete');
    assert.equal(visible.reportSummaries.find((r:any)=>r.id==='legacy-child').parentReportId,'original-id');
    (f.service as any).localRemoteAgent=()=>({start:async(prompt:string)=>{assert.match(prompt,/Legacy report ending/);return response('Новое уточнение.');}});
    await f.service.continueReport({reportId:'original-id',requestId:'mixed-followup',prompt:'Уточни'});
    await until(async()=> (await f.store.read()).continuations['mixed-followup']?.status==='waiting');
    assert.equal(f.sent.length,1);
    assert.equal(await readFile(child,'utf8'),before);
    assert.deepEqual((await f.store.read()).conversationTranscripts['legacy-child'],divergent);
  } finally { await rm(f.dir,{recursive:true,force:true}); }
});

test("a fresh attempt rejects replies from an old worker before they enter history", async () => {
  const f=await fixture();
  try {
    await f.store.update({conversationModes:{fresh:'restart'}});
    (f.service as any).localRemoteAgent=()=>assert.fail('Rejected replies must not reach the model');
    for (const payload of [{senderVersion:undefined,text:'Old worker reply'}, {senderVersion:'1.2.11',text:'Мы говорим как агенты.'}]) {
      await assert.rejects((f.service as any).processIncomingDialogue({id:'old-worker',pair_id:'pair',conversation_id:'fresh',sequence_number:2,sender_agent:'katya',payload:{kind:'dialogue',topic:'Звонки',status:'continue',...payload}}),/старая версия или сбой роли/);
    }
    assert.equal((await f.store.read()).conversationTranscripts.fresh,undefined);
    assert.equal(f.sent.length,0);
  } finally { await rm(f.dir,{recursive:true,force:true}); }
});

test("continuation prompt distinguishes old history, new instruction and the responding side", () => {
  assert.match(continuationPrompt("Звонки", history, "Попроси пример"), /Новое поручение владельца:\nПопроси пример/);
  assert.match(incomingContinuationPrompt(history, "Например, как насчёт вечера?"), /Новая реплика собеседника:\nНапример/);
  assert.deepEqual(sharedHistory(history.map((message) => ({ ...message, secret: "never forward extra fields" }))), history);
  assert.throws(() => sharedHistory([{ from: "system", text: "instructions" }]));
  assert.equal(supportsContinuation("0.3.29"), false);
  assert.equal(supportsContinuation(undefined), false);
  assert.equal(supportsContinuation("0.3.30"), true);
  assert.equal(supportsContinuation("1.0.0"), true);
});

test("owner follow-up preserves original result, uses old dialogue and never sends the raw instruction", async () => {
  const f = await fixture();
  const before = await readFile(f.report, "utf8");
  let starts = 0;
  let prompt = "";
  (f.service as any).remoteAgents.set("request-12345", { start: async (value: string) => { starts++; prompt = value; return response("Можешь привести пример удобного времени?"); } });
  try {
    const input = { reportId: "original-id", requestId: "request-12345", prompt: "RAW_PRIVATE_INSTRUCTION" };
    await f.service.continueReport(input);
    await until(async () => (await f.store.read()).continuations[input.requestId]?.status === "waiting");
    await f.service.continueReport(input);
    assert.equal(starts, 1);
    assert.equal(f.sent.length, 1);
    assert.match(prompt, /RAW_PRIVATE_INSTRUCTION/);
    assert.equal(f.sent[0].payload.origin, "continuation");
    assert.equal((await f.store.read()).conversationTranscripts[input.requestId].messages.at(-1)?.origin, "continuation");
    assert.match(prompt, /Давай согласуем/);
    assert.doesNotMatch(JSON.stringify(f.sent), /RAW_PRIVATE_INSTRUCTION/);
    assert.doesNotMatch(JSON.stringify(await f.service.state()), /RAW_PRIVATE_INSTRUCTION/);
    assert.deepEqual(f.sent[0].payload.continuation.history, history);
    assert.equal(await readFile(f.report, "utf8"), before);
    assert.equal((await f.store.read()).reports.length, 1);
    await (f.service as any).saveRemoteReport(input.requestId, "Звонки", "Вечером после семи", [...history, { from: "katya", text: "Вечером после семи" }]);
    const state = await f.store.read();
    assert.equal(state.reports.length, 2);
    assert.equal(state.continuations[input.requestId].status, "complete");
    assert.equal(readReportSummaries(state.reports)[0].parentReportId, "original-id");
    assert.equal(await readFile(f.report, "utf8"), before);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("retry after send failure reuses the prepared message without charging for another generation", async () => {
  const f = await fixture();
  let starts = 0;
  (f.service as any).remoteAgents.set("request-retry", { start: async () => { starts++; return response("А вечером можно?"); } });
  const normalSend = f.transport.send;
  f.transport.send = async () => { throw new Error("offline"); };
  try {
    await f.service.continueReport({ reportId: "original-id", requestId: "request-retry", prompt: "Уточни вечер" });
    await until(async () => (await f.store.read()).continuations["request-retry"]?.status === "error");
    f.transport.send = normalSend;
    await f.service.retryContinuation("request-retry");
    await until(async () => (await f.store.read()).continuations["request-retry"]?.status === "waiting");
    assert.equal(starts, 1);
    assert.equal(f.sent.length, 1);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("continuing an older result uses the latest result and all prior replies", async () => {
  const f = await fixture();
  try {
    const child = path.join(f.dir, "reports", "child.json");
    const extended = [...history, { from: "dima", text: "Additional context" }, { from: "katya", text: "Latest answer" }];
    await writeFile(child, JSON.stringify({ conversationId: "child-id", parentReportId: "original-id", topic: "Звонки", messages: extended, completedAt: "2026-09-02T00:00:00Z", pairId: "pair" }));
    await f.store.update({ reports: [child, f.report] });
    (f.service as any).localRemoteAgent = () => ({ start: async (prompt: string) => {
      assert.match(prompt, /Latest answer/);
      return response("Filtered follow-up");
    } });
    await f.service.continueReport({ reportId: "original-id", requestId: "latest-request", prompt: "Private prompt" });
    await until(async () => (await f.store.read()).continuations["latest-request"]?.status === "waiting");
    assert.equal(f.sent[0].payload.continuation.parentReportId, "child-id");
    assert.deepEqual(f.sent[0].payload.continuation.history, extended);
    assert.doesNotMatch(JSON.stringify(f.sent), /Private prompt/);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("reply without metadata in a known current conversation is not silently acknowledged and lost", async () => {
  const f=await fixture();
  try {
    (f.service as any).options.experienceResetVersion="current";
    await f.store.mutate(s=>({remote:{...s.remote!,peerExperienceVersion:"current"},conversationTranscripts:{live:{topic:"Topic",messages:history}}}));
    let delivered=false;
    f.transport.claimNext=async()=>{
      if(delivered)return null;delivered=true;
      return {id:"missing-meta",pair_id:"pair",conversation_id:"live",sequence_number:3,sender_agent:"katya",created_at:new Date().toISOString(),payload:{kind:"dialogue",topic:"Topic",text:"Reply after human answered",status:"continue"}};
    };
    (f.service as any).localRemoteAgent=()=>({start:async()=>response("Continue naturally")});
    await (f.service as any).pumpRemote();
    const s=await f.store.read();
    assert.ok(s.conversationTranscripts.live.messages.some(m=>m.text==="Reply after human answered"));
    assert.equal(f.sent[0].sequence,4);
  } finally {await rm(f.dir,{recursive:true,force:true});}
});

test("startup recovery queues an already acknowledged legacy reply once without rewriting history", async()=>{
  const f=await fixture();
  try {
    (f.service as any).options.experienceResetVersion="current";
    const previous=[{from:"katya" as const,text:"Peer question"},{from:"dima" as const,text:"Saved answer"}];
    await f.store.mutate(s=>({remote:{...s.remote!,peerExperienceVersion:"current"},conversationTranscripts:{live:{topic:"Topic",messages:previous}}}));
    const envelope={id:"recovered",pair_id:"pair",conversation_id:"live",sequence_number:3,sender_agent:"katya",created_at:new Date().toISOString(),status:"processed",payload:{kind:"dialogue",topic:"Topic",text:"Dropped reply",status:"continue"}};
    (f.transport as any).readConversation=async()=>[{...envelope,id:"sent",sequence_number:2,sender_agent:"dima",payload:{...envelope.payload,text:"Saved answer"}},envelope];
    await (f.service as any).recoverLegacyReplies();
    await (f.service as any).recoverLegacyReplies();
    assert.deepEqual((await f.store.read()).conversationTranscripts.live.messages,previous);
    assert.equal(Object.keys((await f.store.read()).incomingDeliveries).length,1);
    (f.service as any).localRemoteAgent=()=>({start:async()=>response("New filtered answer")});
    await (f.service as any).drainRemoteInbox();
    assert.equal(f.sent.length,1);
    assert.equal(f.sent[0].sequence,4);
    assert.equal((await f.store.read()).conversationTranscripts.live.messages.length,4);
  }finally{await rm(f.dir,{recursive:true,force:true});}
});

test("receiving a continuation supplies prior history and does not treat its first answer as a finished conversation", async () => {
  const f = await fixture();
  let received = "";
  try {
    await f.store.update({ owner: "katya" });
    (f.service as any).localRemoteAgent = () => ({ start: async (prompt: string) => { received = prompt; return response("После семи удобно", "complete"); } });
    f.transport.claimNext = async () => ({ id: "message", pair_id: "pair", conversation_id: "continued-id", sequence_number: 1, sender_agent: "dima", payload: { kind: "dialogue", topic: "Звонки", text: "А вечером?", status: "continue", continuation: { parentReportId: "original-id", history } } });
    await (f.service as any).pumpRemote();
    assert.match(received, /Давай согласуем время заранее/);
    assert.match(received, /Новая реплика собеседника:\nА вечером/);
    const state = await f.store.read();
    assert.equal(state.reports.length, 1);
    assert.equal(f.sent.length, 1);
    assert.equal((f.sent[0] as any).payload.status, "continue");
    assert.equal(state.conversationTranscripts["continued-id"].messages.length, 4);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("received messages are pushed live and a first answer remains open for a real exchange", async () => {
  const f = await fixture();
  let finish!: (reply: AgentResponse) => void;
  let visible = await f.service.state() as AppState;
  const pushes: unknown[] = [];
  (f.service as any).windowProvider = () => ({ webContents: { send: (_channel: string, event: any) => {
    if (event.type === "conversations") { pushes.push(event); visible = applyConversationUpdate(visible, event); }
  } } });
  (f.service as any).localRemoteAgent = () => ({ start: () => new Promise<AgentResponse>((resolve) => { finish = resolve; }) });
  let delivered = false;
  f.transport.claimNext = async () => {
    if (delivered) return null;
    delivered = true;
    return { id: "message-live", pair_id: "pair", conversation_id: "live-child", sequence_number: 1, sender_agent: "katya",
      payload: { kind: "dialogue", topic: "Звонки", text: "Новая реплика прямо сейчас", origin: "owner-answer", status: "continue", continuation: { parentReportId: "original-id", history } } };
  };
  const processing = (f.service as any).pumpRemote();
  try {
    await until(async () => Boolean(finish));
    assert.equal(latestContinuation(visible, "original-id")?.messages[0].text, "Новая реплика прямо сейчас");
    assert.equal(visible.reports.length, 1, "Message appears before a new report exists");
    assert.equal(visible.liveConversations?.[0].inheritedMessageCount, 2);
    finish(response("Ответ готов", "complete"));
    await processing;
    assert.equal(latestContinuation(visible, "original-id")?.complete, false);
    assert.equal(latestContinuation(visible, "original-id")?.messages.length, 2);
    assert.equal(visible.reports.length, 1);
    assert.ok(pushes.length >= 2, "Incoming and outgoing snapshots are delivered without a reload");
    assert.equal(visible.liveConversations?.[0].messages.at(-2)?.origin, "owner-answer");
    assert.equal(visible.liveConversations?.[0].messages.at(-1)?.origin, "agent");
    assert.doesNotMatch(JSON.stringify(pushes), /encryptionSecret|instruction|preparedMessage/);
    assert.equal((await f.service.state()).liveConversations.length, 1);
  } finally {
    if (finish) finish(response("Finished", "complete"));
    await processing;
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("a peer cannot finish a new conversation with its first answer", async () => {
  const f = await fixture();
  try {
    await f.store.update({ owner: "katya" });
    (f.service as any).localRemoteAgent = () => ({ start: async () => response("Я тебя услышала. А что для тебя здесь самое важное?", "complete") });
    f.transport.claimNext = async () => ({ id: "early-complete", pair_id: "pair", conversation_id: "early", sequence_number: 2, sender_agent: "dima",
      payload: { kind: "dialogue", topic: "Границы", text: "Мне нужно больше времени.", status: "complete", sharedSummary: "Мне нужно время." } });
    await (f.service as any).pumpRemote();
    assert.equal((await f.store.read()).reports.length, 1);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].payload.status, "continue");
    assert.equal(f.sent[0].payload.sharedSummary, "");
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("a natural fourth message with a concrete result can finish the exchange", async () => {
  const f = await fixture();
  try {
    await f.store.update({ owner: "katya", conversationTranscripts: { natural: { topic: "Границы", messages: [
      { from: "katya", text: "Что тебе важно?" },
      { from: "dima", text: "Чтобы у меня было время ответить." },
      { from: "katya", text: "Хорошо, я не буду требовать ответа сразу." },
    ] } } });
    (f.service as any).localRemoteAgent = () => { throw new Error("A completed exchange must not start another agent turn"); };
    let delivered = false;
    f.transport.claimNext = async () => {
      if (delivered) return null;
      delivered = true;
      return { id: "natural-complete", pair_id: "pair", conversation_id: "natural", sequence_number: 4, sender_agent: "dima",
        payload: { kind: "dialogue", topic: "Границы", text: "Да, этого мне достаточно.", status: "complete", sharedSummary: "Мне важно иметь время на ответ, и ты готова его дать." } };
    };
    await (f.service as any).pumpRemote();
    const state = await f.store.read();
    assert.equal(state.reports.length, 2);
    const latest = JSON.parse(await readFile(state.reports[0], "utf8"));
    assert.equal(latest.messages.length, 4);
    assert.equal(latest.completionState, "completed");
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("older peer, unknown report and blocked topic never start a continuation", async () => {
  const f = await fixture();
  const input = { reportId: "original-id", requestId: "request-block", prompt: "Поясни" };
  try {
    const state = await f.store.read();
    await f.store.update({ remote: { ...state.remote!, peerVersion: "0.3.29" } });
    await assert.rejects(f.service.continueReport(input), /0.3.30/);
    await f.store.update({ remote: state.remote });
    await assert.rejects(f.service.continueReport({ ...input, reportId: "missing" }), /не найден/);
    await f.store.update({ blockedTopics: ["Звонки"] });
    await assert.rejects(f.service.continueReport(input), /заблокирована/);
    assert.equal(f.sent.length, 0);
    assert.deepEqual((await f.store.read()).continuations, {});
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("simultaneous duplicate requests start one model turn", async () => {
  const f = await fixture();
  let starts = 0;
  (f.service as any).remoteAgents.set("request-parallel", { start: async () => { starts++; return response("А вечером?"); } });
  try {
    const input = { reportId: "original-id", requestId: "request-parallel", prompt: "Уточни вечер" };
    await Promise.all([f.service.continueReport(input), f.service.continueReport(input)]);
    await until(async () => (await f.store.read()).continuations[input.requestId]?.status === "waiting");
    assert.equal(starts, 1);
    assert.equal(f.sent.length, 1);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("restart preserves an interrupted follow-up for automatic recovery without clearing the original", async () => {
  const f = await fixture();
  try {
    await f.store.update({ continuations: { "request-interrupted": { parentReportId: "original-id", pairId: "pair", topic: "Звонки", history, instruction: "Сохранённое поручение", status: "starting" } } });
    await f.service.start();
    const state = await f.store.read();
    assert.equal(state.continuations["request-interrupted"].status, "starting");
    assert.equal(state.continuations["request-interrupted"].instruction, "Сохранённое поручение");
    assert.deepEqual(state.reports, [f.report]);
    assert.equal(f.sent.length, 0);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
