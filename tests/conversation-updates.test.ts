import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { applyConversationUpdate, keepNewerConversations, latestContinuation, type ConversationUpdateEvent } from "../src/core/conversation-updates.js";
import { ConversationUpdates } from "../src/ui/ConversationUpdates.js";
import type { AppState } from "../src/global.js";

const oldMessage = { speaker: "Катя", text: "Previous conversation", local: false };
const newMessage = { speaker: "Катя", text: "New answer, delivered while reading", local: false };
const parent = { id: "parent", topic: "Calls", summary: "Old result", answerFrom: "Катя", proposedBy: [], completedAt: "", messageCount: 1, messages: [oldMessage] };
const initial = { reportSummaries: [parent], reports: ["parent.json"], conversationRevision: 0, liveConversations: [], continuationStates: [], remote: { configured: true } } as unknown as AppState;
const event = { type: "conversations", conversationRevision: 1, reportSummaries: [parent], reports: ["parent.json"], continuationStates: [{ id: "child", parentReportId: "parent", status: "waiting" }], liveConversations: [{ id: "child", parentReportId: "parent", topic: "Calls", inheritedMessageCount: 1, messages: [oldMessage, newMessage] }] } satisfies ConversationUpdateEvent;

test("a push renders new messages directly under their parent without a reload or navigation", () => {
  const before = renderToStaticMarkup(createElement(ConversationUpdates, { state: initial, reportId: "parent", language: "ru" }));
  assert.equal(before, "");
  const updated = applyConversationUpdate(initial, event);
  const after = renderToStaticMarkup(createElement(ConversationUpdates, { state: updated, reportId: "parent", language: "ru" }));
  assert.match(after, /New answer, delivered while reading/);
  assert.match(after, /role="log"/);
  assert.doesNotMatch(after, /Previous conversation/);
  assert.equal(updated.remote, initial.remote);
  assert.equal(latestContinuation(updated, "unrelated-parent"), undefined);
});

test("parallel conversations with the same topic are routed by parent id, not by topic text", () => {
  const next = applyConversationUpdate(initial, { ...event, liveConversations: [...event.liveConversations,
    { id: "other-child", parentReportId: "other-parent", topic: "Calls", inheritedMessageCount: 0, messages: [{ ...newMessage, text: "Other answer" }] }] });
  assert.equal(latestContinuation(next, "parent")?.messages[0].text, newMessage.text);
  assert.equal(latestContinuation(next, "other-parent")?.messages[0].text, "Other answer");
});

test("duplicate and stale pushes cannot duplicate messages or replace a newer answer", () => {
  const first = applyConversationUpdate(initial, event);
  const duplicate = applyConversationUpdate(first, event);
  assert.equal(latestContinuation(duplicate, "parent")?.messages.length, 1);
  const stale = applyConversationUpdate(duplicate, { ...event, conversationRevision: 0, liveConversations: [] });
  assert.equal(stale, duplicate);
});

test("an older focus or action snapshot cannot erase messages already delivered by an event", () => {
  const pushed = applyConversationUpdate(initial, event);
  const merged = keepNewerConversations(pushed, initial);
  assert.equal(merged.conversationRevision, 1);
  assert.equal(latestContinuation(merged, "parent")?.messages[0].text, newMessage.text);
});

test("completion atomically updates status and leaves the full continuation in the same place", () => {
  const active = applyConversationUpdate(initial, event);
  const report = { ...parent, id: "child", parentReportId: "parent", messageCount: 2, messages: [oldMessage, newMessage] };
  const finished = applyConversationUpdate(active, { ...event, conversationRevision: 2, liveConversations: [],
    reports: ["child.json", "parent.json"], reportSummaries: [report, parent], continuationStates: [{ id: "child", parentReportId: "parent", status: "complete" }] });
  const html = renderToStaticMarkup(createElement(ConversationUpdates, { state: finished, reportId: "parent", language: "ru" }));
  assert.match(html, /New answer, delivered while reading/);
  assert.match(html, /Разговор завершён/);
  assert.doesNotMatch(html, /Previous conversation/);
  assert.equal(finished.continuationStates?.[0].status, "complete");
  assert.deepEqual(finished.reportSummaries[1], parent);
});
