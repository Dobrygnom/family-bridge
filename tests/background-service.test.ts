import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BackgroundService, contextNeedsSync, mergeTopicCatalog, readReportSummaries, recoverInterruptedContextAnalysis, recoverInterruptedTopics } from "../electron/background-service.js";
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

test("topics interrupted while agents start return to the pending queue", () => {
  assert.deepEqual(
    recoverInterruptedTopics(["already pending"], ["first discussion", "already pending", "second discussion"]),
    ["already pending", "first discussion", "second discussion"],
  );
});

test("pair topic catalog stays visible after its launch queue is consumed", () => {
  assert.deepEqual(
    mergeTopicCatalog(["selected topic"], [], ["active topic"], ["completed topic", "selected topic"]),
    ["selected topic", "active topic", "completed topic"],
  );
});

test("saved reports expose their readable shared result inside the app", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "family-bridge-report-view-"));
  try {
    const remotePath = path.join(directory, "remote.json");
    const localPath = path.join(directory, "local.json");
    await writeFile(remotePath, JSON.stringify({ conversationId: "remote-1", topic: "Границы", sharedSummary: "Общий итог", completedAt: "2026-09-01T12:00:00.000Z", messages: [{}, {}] }));
    await writeFile(localPath, JSON.stringify({ conversationId: "local-1", topics: ["Быт"], sharedSummary: "Локальный итог", completedAt: "2026-09-01T13:00:00.000Z", messages: [{}] }));
    assert.deepEqual(readReportSummaries([remotePath, localPath]), [
      { id: "remote-1", topic: "Границы", summary: "Общий итог", completedAt: "2026-09-01T12:00:00.000Z", messageCount: 2 },
      { id: "local-1", topic: "Быт", summary: "Локальный итог", completedAt: "2026-09-01T13:00:00.000Z", messageCount: 1 },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
