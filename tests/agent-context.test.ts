import assert from "node:assert/strict";
import test from "node:test";
import { agentKnowledgeRules, agentTopicRules } from "../src/core/agent-context-rules.js";
import { buildDiscoveryPrompt, buildTopicSelectionPrompt } from "../src/core/topic-discovery-prompts.js";
import { buildTopicRefinementPrompt } from "../src/core/topic-refinement.js";
import { conversationOpeningPrompt } from "../src/core/conversation-quality.js";
import { buildInitialPrompt, buildOwnerQuestionReviewPrompt } from "../src/core/codex-runtime.js";
import { continuationPrompt, incomingContinuationPrompt } from "../src/core/continuation.js";

test("discovery, selection, refinement and legacy openings share the separate-context contract", () => {
  const prompts = [
    buildDiscoveryPrompt("Олег", "ru", "Данные"),
    buildTopicSelectionPrompt([], "Олег", "ru"),
    buildTopicRefinementPrompt({ title: "Среда", brief: {}, instruction: "Суть в инициативе", language: "ru" }),
    conversationOpeningPrompt("Олег", "Какую среду?", { context: "Не хватает встречной инициативы" }),
  ];
  for (const prompt of prompts) {
    assert.ok(prompt.includes(agentTopicRules));
    assert.doesNotMatch(prompt, /Если непонятны дата встречи или смысл конкретного ответа, начни с этого/);
  }
  assert.match(prompts[3], /suggestedOpening — подсказка, не обязательный вопрос/);
});

test("first-person dialogue and continuations do not manufacture autobiographical knowledge", () => {
  const prompts = [
    buildInitialPrompt({ id: "dima", displayName: "Олег", perspective: "Только собственная позиция", workspace: "unused", schemaPath: "unused" }, "Почему ты тогда так написала?"),
    buildOwnerQuestionReviewPrompt("Олег", "Нина"),
    continuationPrompt("Встречи", [], "Поясни"),
    incomingContinuationPrompt([], "Я имел в виду не дату"),
  ];
  for (const prompt of prompts) assert.ok(prompt.includes(agentKnowledgeRules));
  assert.doesNotMatch(prompts[1], /Такие детали выбери самостоятельно/);
  assert.match(prompts[1], /Нельзя снять паузу, если для этого придётся выдумать личный факт/);
  assert.match(prompts[2], /Не угадывай факт ради требования continue/);
});
