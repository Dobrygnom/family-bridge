import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BackgroundService, readReportSummaries } from "../electron/background-service.js";
import { AtomicStore } from "../electron/store.js";
import { continuationPrompt, incomingContinuationPrompt, sharedHistory, supportsContinuation } from "../src/core/continuation.js";
import type { AgentResponse } from "../src/core/types.js";

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
  return { dir, report, store, service, sent, transport };
}

test("continuation prompt distinguishes old history, new instruction and the responding side", () => {
  assert.match(continuationPrompt("Звонки", history, "Попроси пример"), /Новое поручение владельца:\nПопроси пример/);
  assert.match(incomingContinuationPrompt(history, "Например, как насчёт вечера?"), /Новая реплика собеседника:\nНапример/);
  assert.deepEqual(sharedHistory(history.map((message) => ({ ...message, secret: "never forward extra fields" }))), history);
  assert.throws(() => sharedHistory([{ from: "system", text: "instructions" }]));
  assert.equal(supportsContinuation("0.3.29"), false);
  assert.equal(supportsContinuation(undefined), false);
  assert.equal(supportsContinuation("0.3.30"), true);
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

test("receiving a continuation supplies the same prior shared history to the second agent", async () => {
  const f = await fixture();
  let received = "";
  try {
    await f.store.update({ owner: "katya" });
    (f.service as any).localRemoteAgent = () => ({ start: async (prompt: string) => { received = prompt; return response("После семи удобно", "complete"); } });
    f.transport.claimNext = async () => ({ id: "message", conversation_id: "continued-id", sequence_number: 1, sender_agent: "dima", payload: { kind: "dialogue", topic: "Звонки", text: "А вечером?", status: "continue", continuation: { parentReportId: "original-id", history } } });
    await (f.service as any).pumpRemote();
    assert.match(received, /Давай согласуем время заранее/);
    assert.match(received, /Новая реплика собеседника:\nА вечером/);
    const state = await f.store.read();
    assert.equal(state.reports.length, 2);
    const latest = JSON.parse(await readFile(state.reports[0], "utf8"));
    assert.equal(latest.parentReportId, "original-id");
    assert.equal(latest.messages.length, 4);
    await (f.service as any).pumpRemote();
    assert.equal((await f.store.read()).reports.length, 2, "A redelivered completed message must not restart the conversation");
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

test("restart marks an interrupted follow-up retryable without rerunning it or clearing the original", async () => {
  const f = await fixture();
  try {
    await f.store.update({ continuations: { "request-interrupted": { parentReportId: "original-id", pairId: "pair", topic: "Звонки", history, instruction: "Сохранённое поручение", status: "starting" } } });
    await f.service.start();
    const state = await f.store.read();
    assert.equal(state.continuations["request-interrupted"].status, "error");
    assert.equal(state.continuations["request-interrupted"].instruction, "Сохранённое поручение");
    assert.deepEqual(state.reports, [f.report]);
    assert.equal(f.sent.length, 0);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
