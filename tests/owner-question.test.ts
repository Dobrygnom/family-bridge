import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BackgroundService } from "../electron/background-service.js";
import { AtomicStore, type PendingOwnerQuestion } from "../electron/store.js";
import type { AgentResponse, AgentRuntime } from "../src/core/types.js";

class CapturingAgent implements AgentRuntime {
  readonly id = "katya" as const;
  received = "";
  calls = 0;

  async start(message: string): Promise<AgentResponse> {
    this.received = message;
    return this.response();
  }

  async respond(message: string): Promise<AgentResponse> {
    throw new Error(`Owner answer was incorrectly framed as a peer response: ${message}`);
  }

  async respondToOwner(message: string): Promise<AgentResponse> {
    this.received = message;
    return this.response();
  }

  private response(): AgentResponse {
    this.calls++;
    return {
      message_to_peer: "Уточнённый вывод без дословного личного ответа",
      owner_question: "",
      status: "continue",
      topics: ["test topic"],
      private_report: "",
      shared_summary: "",
    };
  }
}

test("owner question survives restart and raw answer is not sent to the peer", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "family-bridge-owner-question-"));
  try {
    const store = new AtomicStore(directory);
    const question: PendingOwnerQuestion = {
      id: "question-1",
      conversationId: "conversation-1",
      topic: "test topic",
      question: "Что на самом деле произошло?",
      createdAt: new Date().toISOString(),
      peerName: "Партнёр",
      nextSequence: 4,
      transcript: [{ from: "dima", text: "Общая безопасная реплика" }],
    };
    await store.update({
      owner: "katya",
      identityConfigured: true,
      displayName: "Катя",
      pendingOwnerQuestions: [question],
      remote: { pairId: "pair-1", encryptionSecret: "secret" },
    });

    const agent = new CapturingAgent();
    const sent: Array<{ payload: { text: string; origin?: string; senderVersion?: string; experienceVersion?: string }; sequence: number }> = [];
    const service = new BackgroundService(directory, process.cwd(), store, () => null, undefined, {appVersion:"1.2.10",experienceResetVersion:"current"});
    const internal = service as unknown as {
      remote: {
        pairState(pairId: string): Promise<{ id: string; owner_id: string; partner_id: string }>;
        identity(): Promise<string>;
        send(input: { payload: { text: string }; sequence: number }): Promise<void>;
      };
      remoteAgents: Map<string, AgentRuntime>;
      codexStatus(): Promise<{ installed: boolean; authenticated: boolean; version: string }>;
    };
    let failFirstSend = true;
    internal.remote = {
      async pairState() { return { id: "pair-1", owner_id: "owner-device", partner_id: "partner-device" }; },
      async identity() { return "partner-device"; },
      async send(input) { sent.push(input); if (failFirstSend) { failFirstSend = false; throw new Error("Lost response"); } },
    };
    internal.remoteAgents.set(question.conversationId, agent);
    internal.codexStatus = async () => ({ installed: true, authenticated: true, version: "test" });

    const before = await service.state();
    assert.deepEqual(before.ownerQuestions, [{
      id: question.id,
      topic: question.topic,
      question: question.question,
      createdAt: question.createdAt,
      peerName: question.peerName,
    }]);
    assert.equal("transcript" in before.ownerQuestions[0], false);

    const rawAnswer = "Сырой личный ответ, который нельзя пересылать";
    await assert.rejects(service.answerOwnerQuestion({ id: question.id, disposition: "answer", answer: rawAnswer }), /Lost response/);
    const prepared = (await store.read()).pendingOwnerQuestions[0];
    assert.equal(prepared.preparedResponse?.message_to_peer, "Уточнённый вывод без дословного личного ответа");
    await service.answerOwnerQuestion({ id: question.id, disposition: "answer", answer: rawAnswer });

    assert.match(agent.received, new RegExp(rawAnswer));
    assert.equal(sent.length, 2);
    assert.equal(agent.calls, 1);
    assert.equal(sent[0].sequence, question.nextSequence);
    assert.equal(sent[0].payload.senderVersion,"1.2.10");
    assert.equal(sent[0].payload.experienceVersion,"current");
    assert.equal(sent[0].payload.text, "Уточнённый вывод без дословного личного ответа");
    assert.equal(sent[0].payload.origin, "owner-answer");
    assert.deepEqual(sent[0].payload, sent[1].payload);
    assert.equal((await service.state()).liveConversations[0].messages.at(-1)?.origin, "owner-answer");
    assert.doesNotMatch(sent[0].payload.text, new RegExp(rawAnswer));
    assert.deepEqual((await store.read()).pendingOwnerQuestions, []);
    const learned = JSON.parse(await readFile(path.join(directory, "psychologist-memory", "learned-context.json"), "utf8")) as Array<{ topic: string; question: string; disposition: string; answer?: string }>;
    assert.deepEqual(learned.map(({ topic, question: savedQuestion, disposition: savedDisposition, answer: savedAnswer }) => ({ topic, question: savedQuestion, disposition: savedDisposition, answer: savedAnswer })), [{
      topic: question.topic,
      question: question.question,
      disposition: "answer",
      answer: rawAnswer,
    }]);
    assert.equal((await service.state()).memory.learnedCount, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("old state files get an empty owner-question queue", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "family-bridge-owner-question-migration-"));
  try {
    const state = await new AtomicStore(directory).read();
    assert.deepEqual(state.pendingOwnerQuestions, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("manual reply mode never invokes an agent and sends the owner's text verbatim", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "family-bridge-manual-reply-"));
  try {
    const store = new AtomicStore(directory);
    await store.update({
      owner: "dima",
      identityConfigured: true,
      displayName: "Дмитрий",
      conversationReplyMode: "manual",
      remote: { pairId: "pair-1", encryptionSecret: "secret", peerName: "Катя" },
    });
    const sent: Array<{ payload: { text: string; origin?: string; status?: string }; sequence: number }> = [];
    const service = new BackgroundService(directory, process.cwd(), store, () => null, undefined, { appVersion: "2.1.5", backgroundTasks: false });
    const internal = service as any;
    internal.remote = {
      async pairState() { return { id: "pair-1", owner_id: "owner-device", partner_id: "partner-device" }; },
      async identity() { return "owner-device"; },
      async readConversation() { return []; },
      async send(input: any) { sent.push(input); },
    };
    internal.localRemoteAgent = () => assert.fail("Manual reply mode must not invoke the agent");
    internal.codexStatus = async () => ({ installed: true, authenticated: true, version: "test" });

    const conversationId = randomUUID();
    const incoming = "Я всё ещё хочу понять, можем ли мы общаться.";
    await internal.processIncomingDialogue({
      id: randomUUID(), pair_id: "pair-1", conversation_id: conversationId, sequence_number: 3,
      sender_agent: "katya", created_at: new Date().toISOString(),
      payload: { protocol: 2, kind: "dialogue", topic: "Как общаться дальше", text: incoming, status: "complete", senderName: "Катя", senderVersion: "2.1.4" },
    });

    const waiting = await service.state();
    assert.equal(sent.length, 0);
    assert.equal(waiting.ownerQuestions.length, 0);
    assert.equal(waiting.liveConversations?.find((item) => item.id === conversationId)?.activity, "needs-answer");
    assert.equal((await store.read()).pendingManualReplies.length, 1);
    assert.equal((await store.read()).conversationTranscripts[conversationId].messages.at(-1)?.text, incoming);

    const exact = "  Мой точный ответ.\n\nНичего не переписывать.  ";
    await service.sendManualFollowUp({ conversationId, text: exact });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].sequence, 4);
    assert.equal(sent[0].payload.text, exact);
    assert.equal(sent[0].payload.origin, "owner-answer");
    assert.equal(sent[0].payload.status, "continue");
    assert.deepEqual((await store.read()).pendingManualReplies, []);
    assert.equal((await store.read()).conversationTranscripts[conversationId].messages.at(-1)?.text, exact);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("manual follow-up replies inside a live conversation and also permits a second owner message", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "family-bridge-live-manual-follow-up-"));
  try {
    const store = new AtomicStore(directory);
    const conversationId = randomUUID();
    const history = [
      { from: "dima" as const, text: "old 1" },
      { from: "katya" as const, text: "old 2" },
      { from: "dima" as const, text: "old 3" },
      { from: "katya" as const, text: "old 4" },
    ];
    const messages = [
      ...history,
      { from: "dima" as const, text: "new 1" },
      { from: "katya" as const, text: "new 2" },
      { from: "katya" as const, text: "new 3" },
    ];
    await store.update({
      owner: "dima",
      identityConfigured: true,
      displayName: "Дмитрий",
      conversationReplyMode: "manual",
      remote: { pairId: "pair-1", encryptionSecret: "secret", peerName: "Катя" },
      conversationTranscripts: { [conversationId]: { topic: "Помощь с котом", messages } },
      conversationInheritedCounts: { [conversationId]: history.length },
      pendingManualReplies: [{
        id: "manual-live-question",
        conversationId,
        topic: "Помощь с котом",
        createdAt: new Date().toISOString(),
        peerName: "Катя",
        nextSequence: 4,
        transcript: messages,
      }],
    });
    const sent: Array<{ payload: { text: string; origin?: string }; sequence: number; conversationId: string }> = [];
    const service = new BackgroundService(directory, process.cwd(), store, () => null, undefined, { appVersion: "2.1.9", backgroundTasks: false });
    const internal = service as any;
    internal.remote = {
      async pairState() { return { id: "pair-1", owner_id: "owner-device", partner_id: "partner-device" }; },
      async identity() { return "owner-device"; },
      async readConversation() { return []; },
      async send(input: any) { sent.push(input); },
    };
    internal.localRemoteAgent = () => assert.fail("A live manual follow-up must not invoke the agent");
    internal.codexStatus = async () => ({ installed: true, authenticated: true, version: "test" });

    const first = "  Да, точно можешь.  ";
    await service.sendManualFollowUp({ conversationId, text: first });
    assert.equal(sent[0].conversationId, conversationId);
    assert.equal(sent[0].sequence, 4);
    assert.equal(sent[0].payload.text, first);
    assert.equal(sent[0].payload.origin, "owner-answer");
    assert.deepEqual((await store.read()).pendingManualReplies, []);

    const second = "И ещё одно сообщение вдогонку.";
    await service.sendManualFollowUp({ conversationId, text: second });
    assert.equal(sent[1].conversationId, conversationId);
    assert.equal(sent[1].sequence, 5);
    assert.equal(sent[1].payload.text, second);
    assert.equal((await store.read()).conversationTranscripts[conversationId].messages.at(-1)?.text, second);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("manual follow-up reconciles an occupied stale sequence and sends the preserved draft next", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "family-bridge-stale-manual-sequence-"));
  try {
    const store = new AtomicStore(directory);
    const conversationId = randomUUID();
    const history = [
      { from: "dima" as const, text: "old 1" }, { from: "katya" as const, text: "old 2" },
      { from: "dima" as const, text: "old 3" }, { from: "katya" as const, text: "old 4" },
    ];
    const messages = [...history,
      { from: "dima" as const, text: "new 1" },
      { from: "katya" as const, text: "new 2" },
      { from: "katya" as const, text: "new 3" },
    ];
    await store.update({
      owner: "dima", identityConfigured: true, displayName: "Дмитрий", conversationReplyMode: "manual",
      remote: { pairId: "pair-1", encryptionSecret: "secret", peerName: "Катя" },
      conversationTranscripts: { [conversationId]: { topic: "Помощь с котом", messages } },
      conversationInheritedCounts: { [conversationId]: history.length },
      pendingManualReplies: [{ id: "preserved-draft", conversationId, topic: "Помощь с котом", createdAt: new Date().toISOString(),
        peerName: "Катя", nextSequence: 4, transcript: messages, text: "Да, точно можешь.", sentAt: "2026-10-26T08:24:08.364Z" }],
    });
    const serverSequenceFour = "Да, можешь точно рассчитывать на меня. Иру просить не нужно.";
    const sent: any[] = [];
    const service = new BackgroundService(directory, process.cwd(), store, () => null, undefined, { appVersion: "2.1.10", backgroundTasks: false });
    const internal = service as any;
    internal.remote = {
      async pairState() { return { id: "pair-1", owner_id: "owner-device", partner_id: "partner-device" }; },
      async identity() { return "owner-device"; },
      async readConversation() { return [{
        id: randomUUID(), pair_id: "pair-1", conversation_id: conversationId, sequence_number: 4,
        sender_id: "owner-device", recipient_id: "partner-device", sender_agent: "dima", status: "processed",
        created_at: "2026-10-25T13:02:41.946Z",
        payload: { protocol: 2, kind: "dialogue", topic: "Помощь с котом", text: serverSequenceFour,
          origin: "owner-answer", status: "continue", sentAt: "2026-10-25T13:02:41.900Z" },
      }]; },
      async send(input: any) { sent.push(input); },
    };

    await service.sendManualFollowUp({ conversationId, text: "Да, точно можешь." });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].sequence, 5);
    assert.equal(sent[0].payload.text, "Да, точно можешь.");
    const state = await store.read();
    assert.deepEqual(state.pendingManualReplies, []);
    assert.deepEqual(state.pendingOwnerQuestions, []);
    assert.equal(state.conversationTranscripts[conversationId].messages.at(-2)?.text, serverSequenceFour);
    assert.equal(state.conversationTranscripts[conversationId].messages.at(-1)?.text, "Да, точно можешь.");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("manual retry treats the same reconciled wire message as delivered instead of duplicating it", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "family-bridge-idempotent-manual-retry-"));
  try {
    const store = new AtomicStore(directory);
    const conversationId = randomUUID();
    const text = "Уже принято сервером.";
    await store.update({
      owner: "dima", identityConfigured: true, displayName: "Дмитрий", conversationReplyMode: "manual",
      remote: { pairId: "pair-1", encryptionSecret: "secret", peerName: "Катя" },
      conversationTranscripts: { [conversationId]: { topic: "Тема", messages: [] } },
      pendingManualReplies: [{ id: "lost-ack", conversationId, topic: "Тема", createdAt: new Date().toISOString(), nextSequence: 1,
        transcript: [], text, sentAt: "2026-10-26T08:24:08.364Z" }],
    });
    const sent: any[] = [];
    const service = new BackgroundService(directory, process.cwd(), store, () => null, undefined, { appVersion: "2.1.10", backgroundTasks: false });
    const internal = service as any;
    internal.remote = {
      async pairState() { return { id: "pair-1", owner_id: "owner-device", partner_id: "partner-device" }; },
      async identity() { return "owner-device"; },
      async readConversation() { return [{ id: randomUUID(), pair_id: "pair-1", conversation_id: conversationId, sequence_number: 1,
        sender_id: "owner-device", recipient_id: "partner-device", sender_agent: "dima", status: "processed", created_at: new Date().toISOString(),
        payload: { protocol: 2, kind: "dialogue", topic: "Тема", text, origin: "owner-answer", status: "continue", sentAt: "2026-10-26T08:24:08.364Z" } }]; },
      async send(input: any) { sent.push(input); },
    };

    await service.sendManualFollowUp({ conversationId, text });
    assert.equal(sent.length, 0);
    assert.deepEqual((await store.read()).pendingManualReplies, []);
    assert.equal((await store.read()).conversationTranscripts[conversationId].messages[0]?.text, text);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed manual delivery keeps the exact durable draft inside its conversation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "family-bridge-durable-manual-failure-"));
  try {
    const store = new AtomicStore(directory);
    const conversationId = randomUUID();
    const text = "  Текст с пробелами и\nточным форматированием.  ";
    await store.update({
      owner: "dima", identityConfigured: true, displayName: "Дмитрий", conversationReplyMode: "manual",
      remote: { pairId: "pair-1", encryptionSecret: "secret", peerName: "Катя" },
      conversationTranscripts: { [conversationId]: { topic: "Тема", messages: [{ from: "katya", text: "Входящая реплика" }] } },
      pendingManualReplies: [{ id: "awaiting-answer", conversationId, topic: "Тема", createdAt: new Date().toISOString(),
        nextSequence: 2, transcript: [{ from: "katya", text: "Входящая реплика" }] }],
    });
    const service = new BackgroundService(directory, process.cwd(), store, () => null, undefined, { appVersion: "2.1.10", backgroundTasks: false });
    const internal = service as any;
    internal.remote = {
      async pairState() { return { id: "pair-1", owner_id: "owner-device", partner_id: "partner-device" }; },
      async identity() { return "owner-device"; },
      async readConversation() { return []; },
      async send() { throw new Error("fetch failed"); },
    };

    await assert.rejects(service.sendManualFollowUp({ conversationId, text }), /fetch failed/);
    const stored = await store.read();
    assert.equal(stored.pendingManualReplies[0].text, text);
    assert.ok(stored.pendingManualReplies[0].sentAt);
    const state = await service.state();
    assert.deepEqual(state.ownerQuestions, []);
    assert.equal(state.liveConversations?.find((item) => item.id === conversationId)?.manualDraft, text);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
