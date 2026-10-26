import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AtomicStore, writeDurableFile } from "../electron/store.js";

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

test("a corrupted primary state recovers the previous durable generation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "family-bridge-store-recovery-"));
  try {
    const file = path.join(directory, "state.json");
    const store = new AtomicStore(directory);
    await store.update({ identityConfigured: true, displayName: "First durable value" });
    await store.update({ displayName: "Second durable value", language: "cs" });
    const backup = JSON.parse(await readFile(`${file}.previous`, "utf8"));
    assert.equal(backup.displayName, "First durable value");

    await writeFile(file, "{interrupted write");
    const restarted = new AtomicStore(directory);
    const recovered = await restarted.read();
    assert.equal(recovered.identityConfigured, true);
    assert.equal(recovered.displayName, "First durable value");
    assert.equal(recovered.language, "ru");
    assert.equal(restarted.recoveryStatus()?.reason, "invalid-primary");
    assert.equal(restarted.recoveryStatus()?.repairedAt, undefined);

    await restarted.update({ language: "en" });
    const status = restarted.recoveryStatus();
    assert.ok(status?.repairedAt);
    assert.equal(status?.invalidPrimaryPreserved, true);
    const corrupt = (await readdir(directory)).filter(name => name.startsWith("state.json.corrupt-"));
    assert.equal(corrupt.length, 1);
    assert.equal(await readFile(path.join(directory, corrupt[0]), "utf8"), "{interrupted write");
    const repaired = await new AtomicStore(directory).read();
    assert.equal(repaired.displayName, "First durable value");
    assert.equal(repaired.language, "en");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an invalid saved participant role recovers the previous durable generation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "family-bridge-store-role-recovery-"));
  try {
    const file = path.join(directory, "state.json");
    const store = new AtomicStore(directory);
    await store.update({ identityConfigured: true, displayName: "Durable identity" });
    await store.update({ language: "cs" });
    const invalid = JSON.parse(await readFile(file, "utf8"));
    invalid.owner = "unexpected-person";
    await writeFile(file, JSON.stringify(invalid));

    const restarted = new AtomicStore(directory);
    const recovered = await restarted.read();
    assert.equal(recovered.owner, "dima");
    assert.equal(recovered.displayName, "Durable identity");
    assert.equal(recovered.language, "ru");
    assert.equal(restarted.recoveryStatus()?.reason, "invalid-primary");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an invalid saved state container or transcript recovers instead of crashing the app", async () => {
  for (const corruption of [
    { conversationTranscripts: null },
    { conversationTranscripts: { broken: { topic: "T", messages: [{ from: "unknown", text: "bad" }] } } },
  ]) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "family-bridge-store-shape-recovery-"));
    try {
      const file = path.join(directory, "state.json");
      const store = new AtomicStore(directory);
      await store.update({ identityConfigured: true, displayName: "Durable identity" });
      await store.update({ language: "cs" });
      const invalid = { ...JSON.parse(await readFile(file, "utf8")), ...corruption };
      await writeFile(file, JSON.stringify(invalid));
      const restarted = new AtomicStore(directory);
      const recovered = await restarted.read();
      assert.equal(recovered.displayName, "Durable identity");
      assert.deepEqual(recovered.conversationTranscripts, {});
      assert.equal(restarted.recoveryStatus()?.reason, "invalid-primary");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("an invalid participant role is rejected before it can be persisted", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "family-bridge-store-role-write-"));
  try {
    const store = new AtomicStore(directory);
    await assert.rejects(store.update({ owner: "unexpected-person" as never }), /Invalid saved participant role/);
    const state = await new AtomicStore(directory).read();
    assert.equal(state.owner, "dima");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("durable files never expose a partial destination and leave no temporary file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "family-bridge-durable-file-"));
  try {
    const file = path.join(directory, "reports", "conversation.json");
    await writeDurableFile(file, "first");
    await writeDurableFile(file, Buffer.from("second"));
    assert.equal(await readFile(file, "utf8"), "second");
    const entries = await import("node:fs/promises").then(fs => fs.readdir(path.dirname(file)));
    assert.deepEqual(entries, ["conversation.json"]);
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
