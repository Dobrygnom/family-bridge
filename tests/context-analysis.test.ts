import assert from "node:assert/strict";
import test from "node:test";
import { CONTEXT_ANALYSIS_VERSION, contextAnalysisNeedsRefresh, normalizeContextAnalysis, routeSensitivity, splitContextMessages, topicsForCounterpart, type ContextAnalysis } from "../src/core/context-analysis.js";

test("context topics keep subject and intended counterpart separate", () => {
  const analysis = normalizeContextAnalysis({
    people: [
      { key: "husband", label: "Муж", relationship: "муж", aliases: [] },
      { key: "lover", label: "Любовник", relationship: "любовник", aliases: [] },
    ],
    portraits: [
      { person_key: "owner", observations: [{ kind: "preference", text: "Владельцу важна ясность." }] },
      { person_key: "husband", observations: [{ kind: "view", text: "Муж считает границы неясными." }] },
    ],
    topics: [
      { title: "Границы в браке", about_people: ["husband"], discuss_with: "husband", sensitivity: "direct", reason: "Прямая тема" },
      { title: "Как говорить о третьем человеке", about_people: ["lover"], discuss_with: "husband", sensitivity: "cross_person", reason: "Перекрёстная тема" },
    ],
  }, "thread", "hash", undefined, "Владелец");
  const husband = analysis.people.find((person) => person.id === "husband")!;
  assert.equal(analysis.analysisVersion, CONTEXT_ANALYSIS_VERSION);
  assert.equal(analysis.portraits?.find((portrait) => portrait.isOwner)?.label, "Владелец");
  assert.equal(analysis.portraits?.find((portrait) => portrait.personId === husband.id)?.observations.length, 1);
  const cross = analysis.topics.find((topic) => topic.sensitivity === "cross_person")!;
  assert.deepEqual(cross.aboutPersonIds, ["lover"]);
  assert.equal(cross.discussWithPersonId, husband.id);
  assert.equal(cross.approved, false);
  cross.approved = true;
  assert.deepEqual(topicsForCounterpart(analysis, husband.id).map((topic) => topic.title), ["Как говорить о третьем человеке"]);
});

test("routing sensitivity follows the corrected subject and counterpart", () => {
  assert.equal(routeSensitivity(["husband"], "husband"), "direct");
  assert.equal(routeSensitivity(["lover"], "husband"), "cross_person");
  assert.equal(routeSensitivity([], "husband"), "unclear");
});

test("long context is split without dropping its beginning or end", () => {
  const chunks = splitContextMessages([{ text: "Начало" }, { text: "x".repeat(40) }, { text: "Конец" }], 30);
  assert.ok(chunks.length > 1);
  assert.match(chunks.join(""), /Начало/);
  assert.match(chunks.join(""), /Конец/);
});

test("an analysis from the old summarizing prompt is recalculated", () => {
  const legacy = { sourceId: "thread", sourceHash: "hash", status: "ready" } as ContextAnalysis;
  assert.equal(contextAnalysisNeedsRefresh(legacy, "thread", "hash"), true);
  const current = { ...legacy, analysisVersion: CONTEXT_ANALYSIS_VERSION };
  assert.equal(contextAnalysisNeedsRefresh(current, "thread", "hash"), false);
});

test("a model-provided duplicate of the owner cannot create a second owner portrait", () => {
  const analysis = normalizeContextAnalysis({
    people: [
      { key: "dmitrii", label: "Дмитрий", relationship: "владелец", aliases: ["Дима"] },
      { key: "katya", label: "Катя", relationship: "жена", aliases: [] },
    ],
    portraits: [
      { person_key: "owner", observations: [{ kind: "fact", text: "Первое наблюдение о Дмитрии." }] },
      { person_key: "dmitrii", observations: [{ kind: "view", text: "Второе наблюдение о Дмитрии." }] },
      { person_key: "katya", observations: [{ kind: "view", text: "Наблюдение о Кате." }] },
    ],
    topics: [{ title: "Поговорить с Катей", about_people: ["katya"], discuss_with: "katya", sensitivity: "direct", reason: "Есть вопрос." }],
  }, "thread", "hash", undefined, "Дмитрий");
  assert.deepEqual(analysis.people.map((person) => person.label), ["Катя"]);
  assert.equal(analysis.portraits?.filter((portrait) => portrait.isOwner).length, 1);
  assert.equal(analysis.portraits?.find((portrait) => portrait.isOwner)?.observations.length, 2);
  assert.equal(new Set(analysis.portraits?.map((portrait) => portrait.personId)).size, analysis.portraits?.length);
});
