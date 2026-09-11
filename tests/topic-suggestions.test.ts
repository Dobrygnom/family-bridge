import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { suggestedTopics, topicAlreadyStarted } from "../src/core/topic-suggestions.js";
import { preserveContextAnalysis, topicsForCounterpart, type ContextAnalysis, type RoutedTopic } from "../src/core/context-analysis.js";
import { BackgroundService } from "../electron/background-service.js";
import { AtomicStore } from "../electron/store.js";

const topic = (title: string, extras: Partial<RoutedTopic> = {}): RoutedTopic => ({ id: title, title, reason: "Saved wording", aboutPersonIds: ["peer"], discussWithPersonId: "peer", sensitivity: "direct", approved: false, ...extras });

test("suggestions exclude started, completed and renamed topics only for the matching person", () => {
  const activity = { remote: { counterpartPersonId: "peer", pairId: "pair" }, activeTopics: [" Active "], reportSummaries: [{ topic: "Completed" }],
    liveConversations: [{ topic: "Original name" }], topicLaunches: { start: { pairId: "pair", topic: "Starting" } } };
  const topics = [topic("Active"), topic("Completed"), topic("Renamed", { sourceTitles: ["Original name"] }), topic("Starting"),
    topic("New"), topic("Unwanted", { dismissed: true }), topic("Completed", { id: "other", discussWithPersonId: "other" })];
  assert.deepEqual(suggestedTopics(topics, activity).map(t => t.id), ["New", "other"]);
  assert.equal(topicAlreadyStarted(topic("Complete"), activity), false);
  assert.equal(topics.length, 7); // Visibility never deletes the underlying records.
});

test("dismissal survives analysis refresh and restart, preserves conversations, and restore does not approve", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fb-suggestions-"));
  try {
    await mkdir(path.join(dir, "psychologist-memory"));
    const initial: ContextAnalysis = { analysisVersion: 5, sourceId: "chat", sourceHash: "old", analyzedAt: "", status: "ready", people: [],
      topics: [topic("Unwanted", { approved: true }), topic("Discussing", { approved: true })] };
    await writeFile(path.join(dir, "psychologist-memory", "context-analysis.json"), JSON.stringify(initial));
    const store = new AtomicStore(dir);
    await store.update({ pendingTopics: ["Unwanted"], pairTopics: ["Unwanted", "Discussing"], activeTopics: ["Discussing"],
      conversationTranscripts: { existing: { topic: "Discussing", messages: [] } }, reports: [path.join(dir, "preserved-report.json")] } as any);
    const before = await store.read();
    const makeService = () => {
      const service = new BackgroundService(dir, process.cwd(), store, () => null, undefined, { backgroundTasks: false }) as any;
      service.state = async () => service.localContextState();
      return service;
    };
    const service = makeService();
    await service.updateContextTopic({ topicId: "Unwanted", dismissed: true });
    const saved = makeService().localContextState().contextAnalysis as ContextAnalysis;
    assert.equal(saved.topics[0].dismissed, true);
    assert.equal(saved.topics[0].approved, false);
    assert.deepEqual(saved.topics[1], initial.topics[1]);
    const refreshed = preserveContextAnalysis({ ...initial, topics: [...initial.topics, topic("New")] }, saved);
    await service.writeContextAnalysis(refreshed, true);
    assert.equal(refreshed.topics[0].dismissed, true);
    assert.deepEqual(topicsForCounterpart(refreshed, "peer").map(t => t.title), ["Discussing"]);
    await service.updateContextTopics({ topicIds: ["Unwanted"], approved: true });
    assert.equal(service.localContextState().contextAnalysis.topics[0].approved, false);
    const after = await store.read();
    assert.deepEqual(after.pendingTopics, []);
    assert.deepEqual(after.activeTopics, before.activeTopics);
    assert.deepEqual(after.conversationTranscripts, before.conversationTranscripts);
    assert.deepEqual(after.reports, before.reports);
    await service.updateContextTopic({ topicId: "Unwanted", dismissed: false });
    const restored = service.localContextState().contextAnalysis.topics[0];
    assert.equal(restored.dismissed, false);
    assert.equal(restored.approved, false);
    assert.deepEqual((await store.read()).pendingTopics, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
