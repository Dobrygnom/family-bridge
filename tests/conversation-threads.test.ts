import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { conversationThreads } from "../src/core/conversation-threads.js";
import { ConversationThreads } from "../src/ui/ConversationThreads.js";
import type { AppState } from "../src/global.js";

const msg = (text: string) => ({ text, speaker: "Me", local: true });
const report = (id: string, parentReportId?: string, texts = [id]) => ({ id, parentReportId, topic: "Same title", summary: "Result", answerFrom: "Peer", proposedBy: ["Me"], completedAt: id, messageCount: texts.length, messages: texts.map(msg) });
const state = (reportSummaries: AppState["reportSummaries"], liveConversations: AppState["liveConversations"] = []) => ({ reportSummaries, liveConversations, remote: { configured: true, peerVersion: "1.2.8" }, continuationStates: [] }) as unknown as AppState;

test("three generations form one card with every new message exactly once and no state mutation", () => {
  const input = state([report("3", "2", ["a", "b", "c"]), report("1", undefined, ["a"]), report("2", "1", ["a", "b"])]);
  const before = JSON.stringify(input);
  const threads = conversationThreads(input);
  assert.equal(threads.length, 1);
  assert.equal(threads[0].id, "1");
  assert.deepEqual(threads[0].stages.flatMap(s => s.newMessages.map(m => m.text)), ["a", "b", "c"]);
  assert.equal(threads[0].latest?.id, "3");
  assert.equal(JSON.stringify(input), before);
});

test("unrelated conversations with identical titles stay separate; service reports are only hidden", () => {
  const input = state([report("1"), report("2"), { ...report("service"), topic: "family-bridge:version:probe" }]);
  assert.equal(conversationThreads(input).length, 2);
  assert.equal(input.reportSummaries.length, 3);
});

test("live continuations and branches remain visible in their parent card", (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { value: {}, configurable: true });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "window", previous); else Reflect.deleteProperty(globalThis, "window"); });
  const input = state([report("1", undefined, ["a"])], [
    { id: "live-a", parentReportId: "1", topic: "Same title", inheritedMessageCount: 1, messages: [msg("a"), msg("b")] },
    { id: "live-b", parentReportId: "1", topic: "Same title", inheritedMessageCount: 1, messages: [msg("a"), msg("c")] },
  ]);
  const [thread] = conversationThreads(input);
  assert.equal(thread.live, true);
  assert.equal(thread.stages.length, 3);
  assert.deepEqual(thread.stages.flatMap(s => s.newMessages.map(m => m.text)), ["a", "b", "c"]);
  const html = renderToStaticMarkup(createElement(ConversationThreads, { state: input, language: "ru", selectedReportId: "", onState: () => {}, activeDictation: "", onDictationBusy: () => {} }));
  assert.equal((html.match(/data-thread-id=/g) ?? []).length, 1);
  assert.match(html, /Разговор продолжается/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /id="report-live-b"/);
  assert.doesNotMatch(html, /class="conversation-thread" open/);
  assert.doesNotMatch(html, /class="report-continuation" open/);
});

test("missing parents, mismatched histories, and cycles never drop unmatched messages", () => {
  const missing = conversationThreads(state([report("child", "missing", ["kept"])]));
  assert.deepEqual(missing[0].stages[0].newMessages.map(m => m.text), ["kept"]);
  const mismatch = conversationThreads(state([report("1", undefined, ["old"]), report("2", "1", ["different"])]));
  assert.equal(mismatch[0].messageCount, 2);
  const cycle = conversationThreads(state([report("1", "2", ["a"]), report("2", "1", ["b"])]));
  assert.equal(cycle.length, 1);
  assert.equal(cycle[0].messageCount, 2);
});

test("completion keeps the same thread id and does not duplicate a stale live snapshot", () => {
  const child = report("2", "1", ["a", "b"]);
  const live = { id: "2", parentReportId: "1", topic: "Same title", inheritedMessageCount: 1, messages: child.messages };
  const parent = report("1", undefined, ["a"]);
  const before = conversationThreads(state([parent], [live]));
  const after = conversationThreads(state([child, parent], [live]));
  assert.equal(before[0].id, after[0].id);
  assert.equal(after[0].live, false);
  assert.equal(after[0].messageCount, 2);
});
