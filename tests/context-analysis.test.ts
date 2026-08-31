import assert from "node:assert/strict";
import test from "node:test";
import { CONTEXT_ANALYSIS_VERSION, contextAnalysisNeedsRefresh, normalizeContextAnalysis, routeSensitivity, splitContextMessages, topicsForCounterpart, type ContextAnalysis } from "../src/core/context-analysis.js";

test("context topics keep subject and intended counterpart separate", () => {
  const analysis = normalizeContextAnalysis({
    people: [
      { key: "husband", label: "Муж", relationship: "муж", aliases: [] },
      { key: "lover", label: "Любовник", relationship: "любовник", aliases: [] },
    ],
    topics: [
      { title: "Границы в браке", about_people: ["husband"], discuss_with: "husband", sensitivity: "direct", reason: "Прямая тема" },
      { title: "Как говорить о третьем человеке", about_people: ["lover"], discuss_with: "husband", sensitivity: "cross_person", reason: "Перекрёстная тема" },
    ],
  }, "thread", "hash");
  const husband = analysis.people.find((person) => person.id === "husband")!;
  assert.equal(analysis.analysisVersion, CONTEXT_ANALYSIS_VERSION);
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
