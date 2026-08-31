import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContextAnalysis, routeSensitivity, topicsForCounterpart } from "../src/core/context-analysis.js";

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
