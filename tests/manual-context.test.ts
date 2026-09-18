import assert from "node:assert/strict";
import test from "node:test";
import { prepareManualContext } from "../src/core/manual-context.js";

test("manual onboarding creates a usable local context without inventing a chat or topics", () => {
  const prepared = prepareManualContext({ ownerName: "Анна", partnerName: "Борис", relationship: "супруг",
    background: "Мы хотим спокойно обсуждать планы.", communicationExamples: "Первый достаточно длинный пример обычного сообщения.\n\nВторой достаточно длинный пример обычного сообщения." }, "2026-09-18T10:00:00.000Z");
  assert.equal(prepared.source.source, "manual");
  assert.equal(prepared.analysis.people.length, 1);
  assert.equal(prepared.analysis.people[0].label, "Борис");
  assert.equal(prepared.analysis.topics.length, 0);
  assert.equal(prepared.analysis.portraits!.find(item => item.isOwner)?.label, "Анна");
  assert.equal(prepared.samples.length, 2);
  assert.match(prepared.profile, /явно введены владельцем/);
});

test("manual onboarding rejects ambiguous or oversized identity data", () => {
  assert.throws(() => prepareManualContext({ ownerName: "Анна", partnerName: "анна" }), /разные имена/);
  assert.throws(() => prepareManualContext({ ownerName: "", partnerName: "Борис" }), /обязательные/);
  assert.throws(() => prepareManualContext({ ownerName: "Анна", partnerName: "Борис", background: "x".repeat(20_001) }), /20000/);
});
