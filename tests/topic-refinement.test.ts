import assert from "node:assert/strict";
import test from "node:test";
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
  assert.throws(() => normalizeTopicRefinement({ title: "x", context: "a".repeat(501), goal: "y", openingQuestion: "z" }), /context/);
});
