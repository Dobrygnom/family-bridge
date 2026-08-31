import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BackgroundService } from "../electron/background-service.js";
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
