import assert from "node:assert/strict";
import test from "node:test";
import { buildApplicationDiagnostics, sanitizeApplicationDiagnostics } from "../electron/application-diagnostics.js";
import type { StoredState } from "../electron/store.js";

test("application diagnostics expose prepared app state but never source chat or pairing secrets", () => {
  const state = {
    owner: "katya", displayName: "Катя", language: "ru", onboardingComplete: true, identityConfigured: true, autoStart: true,
    remote: { pairId: "pair", encryptionSecret: "PAIR_SECRET", inviteSecret: "INVITE_SECRET", peerName: "Дима", peerVersion: "1.2.38" },
    pendingTopics: ["Неотправленная тема"], inFlightTopics: [], pairTopics: [], activeTopics: [], blockedTopics: [],
    topicSources: { "Неотправленная тема": ["local"] }, topicBriefs: {}, reports: [], completedIncoming: [], ignoredConversationIds: [],
    topicLaunches: { launch: { topic: "Неотправленная тема", pairId: "pair", status: "waiting", preparedMessage: "Подготовленный текст", attempts: 1 } },
    pendingOwnerQuestions: [], conversationTranscripts: {}, conversationInheritedCounts: {}, continuations: {}, conversationParents: {}, conversationModes: {},
    incomingDeliveries: {}, quarantinedDeliveries: {},
  } satisfies StoredState;
  const analysis = { analysisVersion: 5, sourceId: "SOURCE_CHAT_ID", sourceHash: "SOURCE_CHAT_HASH", analyzedAt: new Date().toISOString(), status: "ready" as const,
    people: [], topics: [{ id: "topic", title: "Неотправленная тема", aboutPersonIds: [], discussWithPersonId: "dima", sensitivity: "direct" as const,
      reason: "Почему тема создана", approved: true }] };
  const diagnostics = buildApplicationDiagnostics(state, analysis, []);
  assert.equal(diagnostics.topics[0].pending, true);
  assert.equal(diagnostics.topicLaunches[0].preparedMessage, "Подготовленный текст");
  assert.ok(diagnostics.invariants.every(item => item.ok));
  const json = JSON.stringify(diagnostics);
  assert.match(json, /Неотправленная тема|Подготовленный текст/);
  assert.doesNotMatch(json, /PAIR_SECRET|INVITE_SECRET|SOURCE_CHAT_ID|SOURCE_CHAT_HASH|encryptionSecret|inviteSecret|sourceHash|sourceId/);
  assert.equal(JSON.stringify(sanitizeApplicationDiagnostics(diagnostics)), JSON.stringify(diagnostics));
});

test("application diagnostics reject unbounded peer payloads", () => {
  assert.equal(sanitizeApplicationDiagnostics({ schema: 1, at: new Date().toISOString(), topics: [], invariants: [], huge: "x".repeat(4_000_001) }), undefined);
  assert.equal(sanitizeApplicationDiagnostics({ schema: 1, at: new Date().toISOString(), topics: [], invariants: [], nested: { sourceChat: ["raw"] } }), undefined);
});
