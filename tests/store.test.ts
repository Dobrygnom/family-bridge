import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AtomicStore } from "../electron/store.js";

test("identity starts unconfigured and an explicit display name persists", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "family-bridge-store-test-"));
  try {
    const store = new AtomicStore(directory);
    const initial = await store.read();
    assert.equal(initial.identityConfigured, false);
    assert.equal(initial.onboardingComplete, false);
    assert.equal(initial.displayName, "");
    assert.equal(initial.language, "ru");
    assert.deepEqual(initial.inFlightTopics, []);
    assert.deepEqual(initial.pairTopics, []);
    assert.deepEqual(initial.activeTopics, []);
    assert.deepEqual(initial.conversationTranscripts, {});

    await store.update({ owner: "katya", identityConfigured: true, displayName: "Катя", language: "cs" });
    const persisted = await new AtomicStore(directory).read();
    assert.equal(persisted.owner, "katya");
    assert.equal(persisted.identityConfigured, true);
    assert.equal(persisted.displayName, "Катя");
    assert.equal(persisted.language, "cs");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("parallel state updates do not overwrite each other", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "family-bridge-store-race-"));
  try {
    const store = new AtomicStore(directory);
    await Promise.all([
      store.update({ displayName: "Дмитрий" }),
      store.update({ language: "cs" }),
      store.update({ pairTopics: ["Тема"] }),
    ]);
    const state = await store.read();
    assert.equal(state.displayName, "Дмитрий");
    assert.equal(state.language, "cs");
    assert.deepEqual(state.pairTopics, ["Тема"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy manual owner questions migrate into the dedicated durable reply queue", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "family-bridge-manual-migration-"));
  try {
    const conversationId = "ff713d7c-78c6-437b-b243-3905d942c853";
    await writeFile(path.join(directory, "state.json"), JSON.stringify({
      owner: "dima",
      pendingOwnerQuestions: [{
        id: "legacy-manual",
        conversationId,
        topic: "Помощь с котом",
        question: "Ручная реплика владельца в текущий разговор",
        createdAt: "2026-10-26T08:24:08.000Z",
        nextSequence: 4,
        transcript: [{ from: "katya", text: "Можно рассчитывать на тебя?" }],
        manualReply: true,
        preparedResponse: { message_to_peer: "Да, точно можешь.", owner_question: "", status: "continue", shared_summary: "", comparison_summary: "" },
        preparedSentAt: "2026-10-26T08:24:08.364Z",
      }],
    }), "utf8");

    const state = await new AtomicStore(directory).read();
    assert.deepEqual(state.pendingOwnerQuestions, []);
    assert.equal(state.pendingManualReplies.length, 1);
    assert.equal(state.pendingManualReplies[0].conversationId, conversationId);
    assert.equal(state.pendingManualReplies[0].text, "Да, точно можешь.");
    assert.equal(state.pendingManualReplies[0].sentAt, "2026-10-26T08:24:08.364Z");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
