import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BackgroundService } from "../electron/background-service.js";
import { AtomicStore } from "../electron/store.js";

const expectedProject = process.env.FAMILY_BRIDGE_EXPECT_PROJECT;
const expectedChat = process.env.FAMILY_BRIDGE_EXPECT_CHAT;
assert.ok(expectedProject && expectedChat, "Set FAMILY_BRIDGE_EXPECT_PROJECT and FAMILY_BRIDGE_EXPECT_CHAT");

const userData = await mkdtemp(path.join(os.tmpdir(), "family-bridge-context-test-"));
try {
  const store = new AtomicStore(userData);
  await store.update({ language: "ru" });
  const service = new BackgroundService(userData, process.cwd(), store, () => null);
  const threads = await service.listContextThreads();
  const matches = threads.filter((thread) =>
    thread.project.toLocaleLowerCase() === expectedProject.toLocaleLowerCase()
    && thread.title.toLocaleLowerCase() === expectedChat.toLocaleLowerCase());
  assert.equal(matches.length, 1, `Expected one matching context chat; found ${matches.length}`);
  const state = await service.selectContextThread(matches[0].id);
  assert.equal(state.context?.source, "chatgpt");
  assert.equal(state.context?.status, "ready");
  assert.equal(state.contextAnalysis?.status, "ready");
  assert.ok((state.context?.messageCount ?? 0) > 0);
  assert.ok((state.contextAnalysis?.people.length ?? 0) > 0);
  assert.ok((state.contextAnalysis?.topics.length ?? 0) > 0);
  assert.equal(state.contextAnalysis?.topics.filter((topic) => topic.approved).length, 0);
  const grouped = state.contextAnalysis?.people.map((person) => state.contextAnalysis!.topics.filter((topic) => topic.discussWithPersonId === person.id).length) ?? [];
  assert.equal(grouped.reduce((sum, count) => sum + count, 0), state.contextAnalysis?.topics.length);
  console.log(JSON.stringify({
    project: state.context?.project,
    chat: state.context?.title,
    source: state.context?.source,
    messages: state.context?.messageCount,
    people: state.contextAnalysis?.people.length,
    topics: state.contextAnalysis?.topics.length,
    approved: 0,
    grouped,
  }));
} finally {
  await rm(userData, { recursive: true, force: true });
}
