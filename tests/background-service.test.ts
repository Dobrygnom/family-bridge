import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BackgroundService, contextNeedsSync, mergeTopicCatalog, readReportSummaries, recoverInterruptedContextAnalysis, recoverInterruptedTopics, shouldIgnoreLegacyTopicAfterReset } from "../electron/background-service.js";
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

test("old applications cannot repopulate reset topics with stale legacy messages", () => {
  assert.equal(shouldIgnoreLegacyTopicAfterReset("0.3.25", undefined), true);
  assert.equal(shouldIgnoreLegacyTopicAfterReset("0.3.25", "0.3.25"), false);
  assert.equal(shouldIgnoreLegacyTopicAfterReset(undefined, undefined), false);
});

test("the 0.3.25 reset removes old results once and returns every topic to the queue", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "family-bridge-reset-"));
  const exported = path.join(directory, "exported");
  try {
    const reports = path.join(directory, "reports");
    await mkdir(reports, { recursive: true });
    await mkdir(exported, { recursive: true });
    const reportPath = path.join(reports, "old-result.json");
    const exportedPath = path.join(exported, path.basename(reportPath));
    await writeFile(reportPath, JSON.stringify({ conversationId: "finished-id", topic: "finished topic" }));
    await writeFile(exportedPath, "old exported result");
    const store = new AtomicStore(directory);
    await store.update({
      pairTopics: ["selected topic"],
      pendingTopics: ["pending topic"],
      inFlightTopics: ["starting topic"],
      activeTopics: ["active topic"],
      reports: [reportPath],
      conversationTranscripts: { "unfinished-id": { topic: "active topic", messages: [] } },
      pendingOwnerQuestions: [{ id: "question", conversationId: "unfinished-id", topic: "active topic", question: "question", createdAt: new Date().toISOString(), nextSequence: 2, transcript: [] }],
      lastConversationAt: new Date().toISOString(),
    });
    const service = new BackgroundService(directory, process.cwd(), store, () => null, () => undefined, {
      conversationResetVersion: "0.3.25",
      reportsExportDirectory: exported,
      appVersion: "0.3.25",
    });

    await service.start();
    const reset = await store.read();
    assert.deepEqual(reset.pairTopics, ["selected topic", "pending topic", "starting topic", "active topic", "finished topic"]);
    assert.deepEqual(reset.pendingTopics, reset.pairTopics);
    assert.deepEqual(reset.activeTopics, []);
    assert.deepEqual(reset.inFlightTopics, []);
    assert.deepEqual(reset.reports, []);
    assert.deepEqual(reset.pendingOwnerQuestions, []);
    assert.deepEqual(reset.conversationTranscripts, {});
    assert.deepEqual(reset.ignoredConversationIds.sort(), ["finished-id", "unfinished-id"]);
    assert.equal(reset.conversationResetVersion, "0.3.25");
    assert.equal(existsSync(reportPath), false);
    assert.equal(existsSync(exportedPath), false);

    const newReport = path.join(reports, "new-result.json");
    await writeFile(newReport, "new result");
    await store.update({ reports: [newReport] });
    await service.start();
    assert.deepEqual((await store.read()).reports, [newReport]);
    assert.equal(existsSync(newReport), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("saved reports expose their readable shared result inside the app", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "family-bridge-report-view-"));
  try {
    const remotePath = path.join(directory, "remote.json");
    const localPath = path.join(directory, "local.json");
    await writeFile(remotePath, JSON.stringify({ conversationId: "remote-1", topic: "Границы", sharedSummary: "Мне сейчас важно не отвечать сразу.", answerFrom: "Катя", completedAt: "2026-09-01T12:00:00.000Z", messages: [{ from: "dima", text: "Что ты думаешь?" }, { from: "katya", text: "Мне нужно время." }] }));
    await writeFile(localPath, JSON.stringify({ conversationId: "local-1", topics: ["Быт"], sharedSummary: "Локальный итог", completedAt: "2026-09-01T13:00:00.000Z", messages: [{ from: "dima", payload: "Сообщение" }] }));
    assert.deepEqual(readReportSummaries([remotePath, localPath], { localOwnerId: "dima", localName: "Дмитрий", peerName: "Катя" }), [
      { id: "remote-1", topic: "Границы", summary: "Мне сейчас важно не отвечать сразу.", answerFrom: "Катя", completedAt: "2026-09-01T12:00:00.000Z", messageCount: 2, messages: [{ speaker: "Дмитрий", text: "Что ты думаешь?", local: true }, { speaker: "Катя", text: "Мне нужно время.", local: false }] },
      { id: "local-1", topic: "Быт", summary: "Локальный итог", answerFrom: "Катя", completedAt: "2026-09-01T13:00:00.000Z", messageCount: 1, messages: [{ speaker: "Дмитрий", text: "Сообщение", local: true }] },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
