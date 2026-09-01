import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BackgroundService, contextNeedsSync, recoverInterruptedContextAnalysis } from "../electron/background-service.js";
import { AtomicStore } from "../electron/store.js";

test("background service persists a completed mock report and consumes its topic", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "family-bridge-test-"));
  try {
    const store = new AtomicStore(directory);
    await store.update({ pendingTopics: ["neutral test topic"] });
    const service = new BackgroundService(directory, process.cwd(), store, () => null);
    const report = await service.run("neutral test topic", false);
    const state = await store.read();
    assert.equal(report.status, "completed");
    assert.equal(report.turns, 4);
    assert.equal(state.pendingTopics.length, 0);
    assert.equal(state.reports.length, 1);
    const persisted = JSON.parse(await readFile(state.reports[0], "utf8"));
    assert.equal(persisted.conversationId, report.conversationId);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("mock conversation follows the selected language", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "family-bridge-language-test-"));
  try {
    const store = new AtomicStore(directory);
    await store.update({ language: "en" });
    const service = new BackgroundService(directory, process.cwd(), store, () => null);
    const report = await service.run("neutral test topic", false);
    assert.match(report.messages[0].payload, /Let's define one shared goal/);
    assert.match(report.sharedSummary, /two-week experiment/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("automatic context sync runs only for a changed or genuinely stale chat", () => {
  const now = Date.parse("2026-08-31T20:00:00.000Z");
  const selected = { status: "ready" as const, lastSyncedAt: "2026-08-31T18:00:00.000Z", updatedAt: 1_788_134_400 };
  assert.equal(contextNeedsSync(selected, { updatedAt: selected.updatedAt }, now), false);
  assert.equal(contextNeedsSync(selected, { updatedAt: selected.updatedAt + 60 }, now), true);
  assert.equal(contextNeedsSync({ ...selected, updatedAt: undefined }, { updatedAt: undefined }, now), false);
  assert.equal(contextNeedsSync({ ...selected, updatedAt: undefined, lastSyncedAt: "2026-08-31T10:00:00.000Z" }, { updatedAt: undefined }, now), true);
  assert.equal(contextNeedsSync({ ...selected, status: "error" }, { updatedAt: selected.updatedAt }, now), true);
});

test("an interrupted refresh keeps the previously prepared people and topics", () => {
  const interrupted = {
    analysisVersion: 2,
    sourceId: "chat-1",
    sourceHash: "hash-1",
    analyzedAt: "2026-09-01T09:00:00.000Z",
    status: "analyzing" as const,
    progress: { stage: "consolidating" as const, current: 6, total: 6 },
    people: [{ id: "partner", label: "Partner", relationship: "partner", aliases: [] }],
    topics: [],
  };
  const recovered = recoverInterruptedContextAnalysis(interrupted);
  assert.equal(recovered?.status, "ready");
  assert.equal(recovered?.people.length, 1);
  assert.equal(recovered && "progress" in recovered, false);
  const firstRun = { ...interrupted, people: [], topics: [] };
  assert.equal(recoverInterruptedContextAnalysis(firstRun), firstRun);
});
