import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BackgroundService } from "../electron/background-service.js";
import { AtomicStore, type PendingOwnerQuestion } from "../electron/store.js";
import type { AgentResponse, AgentRuntime } from "../src/core/types.js";

class CapturingAgent implements AgentRuntime {
  readonly id = "katya" as const;
  received = "";

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
    const sent: Array<{ payload: { text: string }; sequence: number }> = [];
    const service = new BackgroundService(directory, process.cwd(), store, () => null);
    const internal = service as unknown as {
      remote: {
        pairState(pairId: string): Promise<{ id: string; owner_id: string; partner_id: string }>;
        identity(): Promise<string>;
        send(input: { payload: { text: string }; sequence: number }): Promise<void>;
      };
      remoteAgents: Map<string, AgentRuntime>;
      codexStatus(): Promise<{ installed: boolean; authenticated: boolean; version: string }>;
    };
    internal.remote = {
      async pairState() { return { id: "pair-1", owner_id: "owner-device", partner_id: "partner-device" }; },
      async identity() { return "partner-device"; },
      async send(input) { sent.push(input); },
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
    await service.answerOwnerQuestion({ id: question.id, disposition: "answer", answer: rawAnswer });

    assert.match(agent.received, new RegExp(rawAnswer));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].sequence, question.nextSequence);
    assert.equal(sent[0].payload.text, "Уточнённый вывод без дословного личного ответа");
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
