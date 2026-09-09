import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { conversationThreads } from "../src/core/conversation-threads.js";
import { initialReadingState, parseReadingState, readingReceipt, threadMessages, unreadMessages } from "../src/core/conversation-attention.js";
import { ConversationThreads } from "../src/ui/ConversationThreads.js";
import type { AppState } from "../src/global.js";

const message = (text: string, local = false) => ({ text, local, speaker: local ? "Me" : "Partner" });
const root = { id: "root", topic: "Topic", messages: [message("Old")], completedAt: "2026-09-09", summary: "Old result", answerFrom: "Partner", proposedBy: ["Me"], messageCount: 1 };
const state = (live = false) => ({ reportSummaries: [root], liveConversations: live ? [{ id: "child", parentReportId: "root", topic: "Topic", inheritedMessageCount: 1, messages: [message("Old"), message("New private reply"), message("New local reply",true)] }] : [], remote: {}, continuationStates: [] }) as unknown as AppState;

test("unfocused, collapsed, briefly visible and unmounted messages are not marked read", () => {
  let reads = 0;
  const pending: Array<{ action: () => void; cancelled: boolean }> = [];
  const receipt = readingReceipt(() => reads++, action => {
    const timer = { action, cancelled: false }; pending.push(timer); return () => { timer.cancelled = true; };
  });
  receipt.update(false, true); receipt.update(true, false);
  assert.equal(pending.length, 0);
  receipt.update(true, true); receipt.update(true, false);
  assert.equal(pending[0].cancelled, true); pending[0].action(); assert.equal(reads, 0);
  receipt.update(true, true); receipt.update(false, true);
  assert.equal(pending[1].cancelled, true); pending[1].action(); assert.equal(reads, 0);
  receipt.update(true, true); pending[2].action(); pending[2].action();
  assert.equal(reads, 1);
  const unmounted = readingReceipt(() => reads++, action => { pending.push({ action, cancelled: false }); return () => {}; });
  unmounted.update(true, true); unmounted.dispose(); pending.at(-1)!.action(); assert.equal(reads, 1);
});

test("read markers survive live -> report, inherited history is not new, and message visibility marks only that message", () => {
  const reading = initialReadingState(conversationThreads(state()));
  const next = state(true), thread = conversationThreads(next)[0];
  assert.deepEqual(unreadMessages(thread, reading).map(m => m.key), ["child:1", "child:2"]);
  const seen = { ...reading, seen: { ...reading.seen, "child:2": true as const } };
  assert.deepEqual(unreadMessages(thread, seen).map(m=>m.key), ["child:1"]);
  next.reportSummaries.push({ ...root, id: "child", parentReportId: "root", completedAt: "2026-09-10", messages: next.liveConversations![0].messages, messageCount: 3 });
  assert.deepEqual(unreadMessages(conversationThreads(next)[0], seen).map(m=>m.key), ["child:1"]);
  assert.deepEqual(parseReadingState(JSON.stringify(seen)), seen);
  assert.doesNotMatch(JSON.stringify(seen), /private reply|Old result/);
  assert.equal(parseReadingState("broken"), undefined);
  assert.deepEqual(unreadMessages(thread, undefined), []);
});

test("new continuation badge and real waiting state are separate; receiving a reply never sets disclosure open", () => {
  const input = state(true), reading = initialReadingState(conversationThreads(state()));
  input.liveConversations![0].activity = "retrying";
  const beforeWindow = Object.getOwnPropertyDescriptor(globalThis,"window");
  Object.defineProperty(globalThis,"window",{value:{},configurable:true});
  try {
    const html = renderToStaticMarkup(createElement(ConversationThreads, { state: input, language: "ru", selectedReportId: "", onState:()=>{}, activeDictation:"", onDictationBusy:()=>{}, reading }));
    assert.match(html,/Новое · 2/); assert.match(html,/Отправка отложена/);
    assert.doesNotMatch(html, /class="conversation-thread" open/);
    assert.equal(threadMessages(conversationThreads(input)[0]).length, 3);
  } finally { if(beforeWindow)Object.defineProperty(globalThis,"window",beforeWindow);else Reflect.deleteProperty(globalThis,"window"); }
});
