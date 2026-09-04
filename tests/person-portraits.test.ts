import assert from "node:assert/strict";
import test from "node:test";
import { applyPortraitUpdates, buildInitialPortraits, updatePortraitObservation } from "../src/core/person-portraits.js";

test("source chat creates separate portraits for the owner and known people", () => {
  const portraits = buildInitialPortraits({
    sourceId: "chat-1",
    now: "2026-09-04T00:00:00.000Z",
    people: [
      { personKey: "owner", personId: "owner", label: "Дмитрий", relationship: "", isOwner: true },
      { personKey: "katya", personId: "katya", label: "Катя", relationship: "жена", isOwner: false },
    ],
    raw: [
      { person_key: "owner", observations: [{ kind: "preference", text: "Дмитрию важны прямые ответы." }] },
      { person_key: "katya", observations: [{ kind: "uncertainty", text: "Позиция Кати по этому вопросу пока неизвестна." }] },
    ],
  });
  assert.deepEqual(portraits.map((portrait) => [portrait.personId, portrait.isOwner, portrait.observations.length]), [
    ["owner", true, 1],
    ["katya", false, 1],
  ]);
  assert.equal(portraits[0].observations[0].sourceType, "source_chat");
});

test("a completed dialogue adds only person-specific observations and keeps their source", () => {
  const initial = buildInitialPortraits({
    sourceId: "chat-1",
    people: [
      { personKey: "owner", personId: "owner", label: "Дмитрий", relationship: "", isOwner: true },
      { personKey: "katya", personId: "katya", label: "Катя", relationship: "жена", isOwner: false },
    ],
    raw: [],
  });
  const updated = applyPortraitUpdates(initial, { updates: [
    { person_id: "owner", observations: [{ kind: "view", text: "Дмитрий связывает напряжение с ремонтом дома." }] },
    { person_id: "katya", observations: [{ kind: "preference", text: "Катя предпочитает не принимать решения под давлением." }] },
    { person_id: "relationship", observations: [{ kind: "fact", text: "Такого портрета быть не должно." }] },
  ] }, { id: "conversation-1", label: "Почему мы расстались", completedAt: "2026-09-04T01:00:00.000Z" });
  assert.equal(updated[0].observations[0].sourceType, "conversation");
  assert.equal(updated[0].observations[0].sourceLabel, "Почему мы расстались");
  assert.equal(updated[1].observations[0].text, "Катя предпочитает не принимать решения под давлением.");
  assert.equal(updated.some((portrait) => portrait.personId === "relationship"), false);
});

test("user can correct or delete one observation without rewriting the portrait", () => {
  const portraits = buildInitialPortraits({
    sourceId: "chat-1",
    people: [{ personKey: "owner", personId: "owner", label: "Дмитрий", relationship: "", isOwner: true }],
    raw: [{ person_key: "owner", observations: [
      { kind: "view", text: "Старое суждение." },
      { kind: "fact", text: "Другой факт." },
    ] }],
  });
  const target = portraits[0].observations[0];
  const corrected = updatePortraitObservation(portraits, { personId: "owner", observationId: target.id, text: "Исправленное суждение." }, "2026-09-04T02:00:00.000Z");
  assert.equal(corrected[0].observations[0].text, "Исправленное суждение.");
  assert.equal(corrected[0].observations[0].userEdited, true);
  assert.equal(corrected[0].observations.length, 2);
  const removed = updatePortraitObservation(corrected, { personId: "owner", observationId: target.id, remove: true });
  assert.deepEqual(removed[0].observations.map((item) => item.text), ["Другой факт."]);
});
