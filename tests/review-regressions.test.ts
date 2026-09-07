import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BackgroundService } from "../electron/background-service.js";
import { AtomicStore } from "../electron/store.js";
import { normalizeContextAnalysis, preserveContextAnalysis } from "../src/core/context-analysis.js";
import { relevantContextExcerpts } from "../src/core/context-excerpts.js";
import { completionReadiness } from "../src/core/conversation-quality.js";

const raw = { people: [{ key: "partner", label: "Partner", relationship: "wife", aliases: [] }], topics: [1, 2].map((n) => ({ title: `Topic ${n}`, about_people: ["partner"], discuss_with: "partner", sensitivity: "direct" as const, reason: "Наблюдаемая динамика: Original. Психологическая цель: Understand. Первый вопрос: Why?" })) };
const original = () => normalizeContextAnalysis(raw, "source", "hash");
const reply = (text = "Answer") => ({ message_to_peer: text, status: "continue" as const, owner_question: "", shared_summary: "", comparison_summary: "", private_report: "", topics: [] });
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fb-review-regressions-"));
  await mkdir(path.join(dir, "psychologist-memory"));
  const file = path.join(dir, "psychologist-memory", "context-analysis.json");
  await writeFile(file, JSON.stringify(original()));
  const store = new AtomicStore(dir);
  await store.update({ identityConfigured: true, displayName: "Owner", remote: { pairId: "pair", encryptionSecret: "test", counterpartPersonId: "partner" } });
  const service = new BackgroundService(dir, process.cwd(), store, () => null, undefined, { backgroundTasks: false });
  const sent: any[] = [];
  const queue: any[] = [];
  const transport = { pairState: async () => ({ id: "pair", owner_id: "one", partner_id: "two" }), identity: async () => "one", claimNext: async () => queue.shift() ?? null, acknowledge: async (_id: string) => {}, send: async (message: any) => { sent.push(message); return "sent"; } };
  Object.assign(service as any, { remote: transport, versionProbePair: "pair:two", syncedTopicsForPair: "pair:two" });
  return { dir, file, store, service, transport, queue, sent, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
const envelope = (id = "message", conversation = "conversation") => ({ id, pair_id: "pair", conversation_id: conversation, sequence_number: 1, sender_agent: "katya", payload: { kind: "dialogue", topic: "Topic", text: "Incoming", status: "continue" } });
async function until(check: () => boolean) {
  for (let n = 0; n < 300; n++) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error("Timed out");
}

test("refresh preserves wording, consent and stable person IDs; another source is separate", () => {
  const edited = original();
  edited.topics[0].sourceTitles = [edited.topics[0].title];
  edited.topics[0].title = "User wording";
  edited.topics[0].reason = "User facts";
  edited.topics[0].approved = true;
  const changedKeys = { people: [{ ...raw.people[0], key: "wife" }], topics: raw.topics.map((topic) => ({ ...topic, about_people: ["wife"], discuss_with: "wife" })) };
  const refreshed = normalizeContextAnalysis(changedKeys, "source", "new-hash", edited);
  assert.equal(refreshed.people[0].id, "partner");
  assert.deepEqual(refreshed.topics, edited.topics);
  assert.equal(refreshed.sourceHash, "new-hash");
  assert.equal(normalizeContextAnalysis(raw, "other", "new", edited).topics.some((topic) => topic.approved), false);
  assert.deepEqual(preserveContextAnalysis(original(), edited).topics, edited.topics);
});

test("parallel approvals and late analysis checkpoints preserve every selection", async () => {
  const f = await fixture();
  try {
    await Promise.all(original().topics.map((topic) => f.service.updateContextTopic({ topicId: topic.id, approved: true })));
    await (f.service as any).writeContextAnalysis(original(), true);
    assert.equal(JSON.parse(await readFile(f.file, "utf8")).topics.filter((topic: any) => topic.approved).length, 2);
    assert.deepEqual((await f.store.read()).pendingTopics.sort(), ["Topic 1", "Topic 2"]);
  } finally { await f.cleanup(); }
});

test("blocked incoming dialogue never generates or sends a reply", async () => {
  const f = await fixture();
  try {
    await f.store.update({ blockedTopics: ["topic"] });
    (f.service as any).localRemoteAgent = () => { throw new Error("Must not generate"); };
    f.queue.push(envelope());
    await (f.service as any).pumpRemote();
    assert.equal(f.sent.length, 0);
    assert.deepEqual((await f.store.read()).conversationTranscripts, {});
    assert.deepEqual((await f.store.read()).completedIncoming, ["message"]);
  } finally { await f.cleanup(); }
});

test("failed sending survives restart and redelivery without duplicate generation or transcript", async () => {
  const f = await fixture();
  let generations = 0;
  try {
    (f.service as any).localRemoteAgent = () => ({ start: async () => { generations++; return reply(); } });
    f.transport.send = async () => { throw new Error("Connection lost"); };
    f.queue.push(envelope());
    await (f.service as any).pumpRemote();
    assert.equal(generations, 1);
    assert.doesNotMatch(JSON.stringify(await f.service.state()), /incomingDeliveries|completedIncoming/);
    assert.equal((await f.store.read()).conversationTranscripts.conversation.messages.length, 1, "Unsent answer is not presented as delivered");
    const restarted = new BackgroundService(f.dir, process.cwd(), f.store, () => null, undefined, { backgroundTasks: false });
    Object.assign(restarted as any, { remote: f.transport, versionProbePair: "pair:two", syncedTopicsForPair: "pair:two", localRemoteAgent: () => ({ start: async () => { generations++; return reply("WRONG"); } }) });
    f.transport.send = async (message: any) => { f.sent.push(message); return "sent"; };
    f.queue.push(envelope());
    await (restarted as any).pumpRemote();
    f.queue.push(envelope());
    await (restarted as any).pumpRemote();
    assert.equal(generations, 1);
    assert.equal(f.sent.length, 1);
    assert.deepEqual((await f.store.read()).conversationTranscripts.conversation.messages.map((message) => message.text), ["Incoming", "Answer"]);
    assert.deepEqual((await f.store.read()).incomingDeliveries, {});
  } finally { await f.cleanup(); }
});

test("slow model does not block version probes or another conversation", async () => {
  const f = await fixture();
  let finish: ((value: ReturnType<typeof reply>) => void) | undefined;
  let processing: Promise<void> | undefined;
  try {
    (f.service as any).localRemoteAgent = (id: string) => ({ start: () => id === "slow" ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(reply("Second answer")) });
    f.queue.push(envelope("slow-message", "slow"));
    processing = (f.service as any).pumpRemote();
    await until(() => Boolean(finish));
    f.queue.push({ ...envelope("probe", "probe"), payload: { kind: "topic", topic: "probe", versionOnly: true, requestVersion: true, senderVersion: "1.2.3" } });
    await (f.service as any).pumpRemote();
    assert.ok(f.sent.some((message) => message.payload.versionOnly));
    f.queue.push(envelope("second-message", "second"));
    await (f.service as any).pumpRemote();
    assert.ok(f.sent.some((message) => message.payload.text === "Second answer"));
  } finally { finish?.(reply()); await processing; await f.cleanup(); }
});

test("refinement gets private source context, correct recipient and the last preview; nothing is shared", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.dir, "psychologist-memory", "style-samples.jsonl"), JSON.stringify({ text: "PRIVATE_FACT: work evenings cause missed calls" }));
    let input: any;
    (f.service as any).options.topicRefiner = { refine: async (value: unknown) => { input = value; return value; } };
    const preview = { title: "Last preview", context: "Evening calls", goal: "Understand", openingQuestion: "When?" };
    await f.service.refineContextTopic({ topicId: original().topics[0].id, instruction: "Make this clearer", preview });
    assert.equal(input.title, preview.title);
    assert.match(input.privateContext, /PRIVATE_FACT/);
    assert.match(input.recipientName, /Partner/);
    assert.equal(f.sent.length, 0);
    assert.equal(JSON.parse(await readFile(f.file, "utf8")).topics[0].title, "Topic 1");
  } finally { await f.cleanup(); }
});

test("relevant old messages and neighbours remain available; an embedded unanswered question cannot finish", () => {
  const messages = [{ text: "Before the house discussion" }, { text: "Mortgage and house budget worry me" }, { text: "This happened last winter" }, ...Array.from({ length: 100 }, () => ({ text: "Unrelated news" }))];
  const selected = relevantContextExcerpts(messages.map((message) => JSON.stringify(message)).join("\n"), "house mortgage budget");
  assert.match(selected, /Mortgage and house budget/);
  assert.match(selected, /last winter/);
  assert.equal(completionReadiness({ sequence: 6, message: "Когда тебе удобно? Я могу вечером.", sharedSummary: "Вечером" }).ready, false);
});
