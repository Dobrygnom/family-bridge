import assert from "node:assert/strict";
import test from "node:test";
import { completionReadiness, conversationOpeningPrompt, findTopicContext, prematureCompletionInstruction, sanitizeTopicBrief, shareableTopicBrief, topicKey } from "../src/core/conversation-quality.js";
import type { ContextAnalysis } from "../src/core/context-analysis.js";

const analysis: ContextAnalysis = {
  analysisVersion: 2,
  sourceId: "source",
  sourceHash: "hash",
  analyzedAt: new Date(0).toISOString(),
  status: "ready",
  people: [],
  topics: [{
    id: "topic",
    title: "Порядок изменения договорённостей",
    aboutPersonIds: ["partner"],
    discussWithPersonId: "partner",
    sensitivity: "direct",
    approved: true,
    reason: "Наблюдаемая динамика: планы менялись без обсуждения. Психологическая цель: договориться, как менять общие планы. Первый вопрос: «Что ты хочешь делать до изменения общей договорённости?»",
  }],
};

test("a selected topic keeps its goal and opening question instead of becoming only a title", () => {
  const topic = findTopicContext(analysis, "  порядок   ИЗМЕНЕНИЯ договорённостей ");
  assert.equal(topic?.id, "topic");
  assert.deepEqual(shareableTopicBrief(topic), {
    context: "планы менялись без обсуждения.",
    goal: "договориться, как менять общие планы.",
    openingQuestion: "Что ты хочешь делать до изменения общей договорённости?",
  });
  assert.equal(topicKey(" Твёрдые   планы "), topicKey("твёрдые планы"));
});

test("topic briefs accept only bounded plain fields", () => {
  assert.deepEqual(sanitizeTopicBrief({ context: "Планы менялись без предупреждения", goal: "Понять друг друга", openingQuestion: "Что ты думаешь?", ignored: "no" }), { context: "Планы менялись без предупреждения", goal: "Понять друг друга", openingQuestion: "Что ты думаешь?" });
  assert.equal(sanitizeTopicBrief({ goal: "x".repeat(801) }), undefined);
  assert.equal(sanitizeTopicBrief("not an object"), undefined);
});

test("the opening is a contextual human message rather than a spoken topic title", () => {
  const prompt = conversationOpeningPrompt("Дмитрий", "Обсудить причины расставания", {
    context: "Дом и финансовое напряжение постепенно вытеснили близость, а оба стали чаще закрываться.",
    goal: "понять, что стало решающим для каждого",
    openingQuestion: "В какой момент продолжение отношений перестало казаться тебе возможным?",
  });
  assert.match(prompt, /Дом и финансовое напряжение/);
  assert.match(prompt, /2–4 естественных предложениях/);
  assert.match(prompt, /свою реакцию или сомнение/);
  assert.match(prompt, /один живой прямой вопрос/);
  assert.match(prompt, /Не произноси название темы/);
});

test("a first answer is not a finished conversation and an unanswered question cannot close it", () => {
  const firstAnswer = completionReadiness({ sequence: 2, message: "Мне нужно больше времени.", sharedSummary: "Мне нужно время." });
  assert.equal(firstAnswer.ready, false);
  assert.match(prematureCompletionInstruction("Границы", firstAnswer.reasons), /Не завершай разговор сейчас/);
  assert.equal(completionReadiness({ sequence: 4, message: "А как это видишь ты?", sharedSummary: "Мы поняли позиции." }).ready, false);
  assert.equal(completionReadiness({ sequence: 4, message: "Да, теперь я понимаю, где мы расходимся.", sharedSummary: "Я вижу это иначе, но теперь понимаю твою позицию." }).ready, true);
});
