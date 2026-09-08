import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { TOPIC_BRIEF_LIMIT, TOPIC_TITLE_LIMIT } from "../src/core/topic-limits.js";
import { sanitizeTopicBrief } from "../src/core/conversation-quality.js";
import { buildTopicRefinementPrompt, normalizeTopicRefinement } from "../src/core/topic-refinement.js";

test("topic refinement prompt marks the user's request as private editing data", () => {
  const prompt = buildTopicRefinementPrompt({
    title: "Старое название",
    brief: { context: "Старый контекст.", goal: "Понять позицию.", openingQuestion: "Что ты думаешь?" },
    instruction: "Уточни, что речь о вчерашнем разговоре",
    language: "ru",
  });
  assert.match(prompt, /ничего не отправляй/i);
  assert.match(prompt, /<user_refinement>/);
  assert.match(prompt, /не включай в результат само поручение/i);
  assert.match(prompt, /вчерашнем разговоре/);
});

test("topic refinement output is normalized and bounded before preview", () => {
  assert.deepEqual(normalizeTopicRefinement({
    title: "  Конкретный   разговор  ",
    context: "  Что произошло.  ",
    goal: "  Что понять.  ",
    openingQuestion: "  Как ты это видишь?  ",
  }), {
    title: "Конкретный разговор",
    context: "Что произошло.",
    goal: "Что понять.",
    openingQuestion: "Как ты это видишь?",
  });
  assert.throws(() => normalizeTopicRefinement({ title: "", context: "x", goal: "y", openingQuestion: "z" }), /title/);
  assert.throws(() => normalizeTopicRefinement({ title: "x", context: "a".repeat(801), goal: "y", openingQuestion: "z" }), /context/);
});

test("refinement schema, existing preview and transport agree at the boundary", () => {
  const schema = JSON.parse(readFileSync(new URL("../schemas/topic-refinement.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.properties.title.maxLength, TOPIC_TITLE_LIMIT);
  for (const field of ["context", "goal", "openingQuestion"] as const) {
    assert.equal(schema.properties[field].maxLength, TOPIC_BRIEF_LIMIT);
    for (const length of [501, TOPIC_BRIEF_LIMIT]) {
      const preview = { title: "Topic", context: "Context", goal: "Goal", openingQuestion: "Question", [field]: "я".repeat(length) };
      assert.deepEqual(normalizeTopicRefinement(preview), preview);
      assert.equal(sanitizeTopicBrief(preview)?.[field], preview[field]);
    }
    assert.throws(() => normalizeTopicRefinement({ title: "Topic", context: "Context", goal: "Goal", openingQuestion: "Question", [field]: "я".repeat(TOPIC_BRIEF_LIMIT + 1) }), new RegExp(field));
  }
});
