import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AtomicStore } from "../electron/store.js";
import { migrateRepairIdentifiers, repairRequestId } from "../electron/repair-identifiers.js";

test("repair IDs fit the server UUID column, and migration retains prepared text and history exactly once", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fb-repair-ids-"));
  try {
    const store = new AtomicStore(dir), root = "c5f09a3a-ea8f-4504-803e-ea526bc2e498", old = `repair-1211-${root}`, id = repairRequestId(root);
    assert.match(id, /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    assert.equal(id, repairRequestId(root)); assert.notEqual(id, repairRequestId("another-root"));
    const request = { parentReportId: root, originReportId: root, pairId: "pair", topic: "Keep topic", instruction: "Keep instruction", history: [], mode: "restart" as const, status: "error" as const, attempts: 3, preparedMessage: "Already approved agent output" };
    const transcript = { topic: request.topic, messages: [{ from: "katya" as const, text: request.preparedMessage }] };
    const before = await store.update({ continuations: { [old]: request }, conversationTranscripts: { [old]: transcript }, conversationModes: { [old]: "restart" }, conversationParents: { [old]: root }, reports: ["keep-report"], pairTopics: ["Keep topic"] });
    const migrated = await store.mutate(migrateRepairIdentifiers);
    assert.equal(migrated.continuations[id].status, "starting");
    assert.equal(migrated.continuations[id].attempts, 0);
    assert.equal(migrated.continuations[id].preparedMessage, request.preparedMessage);
    assert.equal(migrated.continuations[id].instruction, request.instruction);
    assert.deepEqual(migrated.conversationTranscripts[id], transcript);
    assert.deepEqual(migrated.reports, before.reports); assert.deepEqual(migrated.pairTopics, before.pairTopics);
    assert.equal(migrated.continuations[old], undefined);
    assert.deepEqual(migrateRepairIdentifiers(migrated), {});
    // An established exchange is not an unsent launch and must never be remapped.
    const established = { ...before, conversationTranscripts: { [old]: { ...transcript, messages: [...transcript.messages, { from: "dima" as const, text: "Peer already replied" }] } } };
    assert.deepEqual(migrateRepairIdentifiers(established), {});
    // A pairing failure can happen before any model output exists.
    const unprepared = { ...before, continuations: { [old]: { ...request, preparedMessage: undefined } }, conversationTranscripts: {} };
    const fixed = migrateRepairIdentifiers(unprepared);
    assert.equal(fixed.continuations![old], undefined);
    assert.equal(fixed.continuations![id].status, "error");
    assert.equal(fixed.continuations![id].attempts, 3, "Migration must not erase the retry budget");
    assert.equal(fixed.continuations![id].retryAt, 0);
    assert.equal(fixed.continuations![id].preparedMessage, undefined);
    assert.deepEqual(fixed.continuations![id].history, request.history);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
