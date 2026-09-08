import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexContextAnalyzer, normalizeContextAnalysis } from "../src/core/context-analysis.js";
import { coverageSchema, validateCoverage, selectionEvidence, topicCoverageRules, dialogueGroupingPrompt, type CoverageAnalysis } from "../src/core/topic-coverage.js";
import { shareableTopicBrief } from "../src/core/conversation-quality.js";
import { topicNeedsReview, topicRelevanceLabel } from "../src/core/topic-review.js";

const raw = (): CoverageAnalysis => ({ people: [{ key: "peer", label: "Нина", relationship: "партнёр", aliases: [] }], portraits: [],
  topics: [{ id: "T1", title: "Незакрытый вопрос", about_people: ["peer"], discuss_with: "peer", sensitivity: "direct", relevance: "check_relevance", reason: `Контекст: ${"а".repeat(650)} Что хотим понять: Понять. Начало разговора: Я хотел понять нашу разницу. Как ты смотришь на это?` }],
  decisions: [{ candidateId: "C1", disposition: "included", topicIds: ["T1"], reason: "Нерешённый вопрос" }, { candidateId: "C2", disposition: "merged", topicIds: ["T1"], reason: "Другой эпизод того же вопроса" }],
});
const inputs = [{ id: "C1", discuss_with: "peer" }, { id: "C2", discuss_with: "peer" }];

test("coverage catches silently lost candidates, invented topics and broken mappings", () => {
  validateCoverage(raw(), inputs);
  const missing = raw(); missing.decisions.pop(); assert.throws(() => validateCoverage(missing, inputs));
  const duplicate = raw(); duplicate.decisions[1].candidateId = "C1"; assert.throws(() => validateCoverage(duplicate, inputs));
  const dangling = raw(); dangling.decisions[1].topicIds = ["made-up"]; assert.throws(() => validateCoverage(dangling, inputs));
  const unexplained = raw(); unexplained.decisions[1].reason = ""; assert.throws(() => validateCoverage(unexplained, inputs));
  const invented = raw(); invented.topics.push({ ...invented.topics[0], id: "T2" }); assert.throws(() => validateCoverage(invented, inputs));
});
test("grouping cannot merge different people or split one topic again", () => {
  validateCoverage(raw(), inputs, true);
  assert.throws(() => validateCoverage(raw(), [inputs[0], { id: "C2", discuss_with: "someone-else" }], true));
  const split = raw(); split.topics.push({ ...split.topics[0], id: "T2" }); split.decisions[0].topicIds.push("T2");
  assert.throws(() => validateCoverage(split, inputs, true));
});
test("relevance survives normalization without approving or truncating the expanded brief", () => {
  const analysis = normalizeContextAnalysis(raw(), "source", "hash");
  assert.equal(analysis.topics[0].relevance, "check_relevance");
  assert.equal(analysis.topics[0].approved, false);
  assert.equal(shareableTopicBrief(analysis.topics[0])?.context?.length, 650);
  assert.equal(topicNeedsReview(analysis.topics[0]), true);
  assert.equal(topicNeedsReview({ ...analysis.topics[0], relevance: "current" }), false);
  for (const lang of ["ru", "en", "cs", "fr"]) assert.ok(topicRelevanceLabel(lang));
});
test("selection includes referenced older evidence and whole recent messages", () => {
  const messages = Array.from({ length: 100 }, (_, i) => ({ text: `Message ${i + 1}` }));
  const evidence = selectionEvidence(messages, [{ reason: "#3–5 и №10" }]);
  assert.deepEqual(evidence.slice(0, 4).map(item => item.number), [3, 4, 5, 10]);
  assert.equal(evidence.at(-1)?.number, 100);
  assert.match(topicCoverageRules, /НЕ означают решение/);
  assert.match(dialogueGroupingPrompt(raw(), "Олег", "ru", []), /естественный содержательный ДИАЛОГ/);
});
test("production analyzer runs selection and grouping, validates coverage and reuses completed cache", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "fb-coverage-test-"));
  try {
    const analyzer = new CodexContextAnalyzer("unused", workspace, path.resolve("schemas/context-analysis.schema.json")) as any;
    let calls = 0;
    analyzer.run = async (prompt: string, _model: string[], schemaFile: string) => {
      const schema = JSON.parse(await readFile(schemaFile, "utf8")); assert.ok(schema.properties.decisions); calls++;
      if (calls === 1) { assert.match(prompt, /C2/); return raw(); }
      assert.match(prompt, /ДИАЛОГ/);
      return { ...raw(), decisions: [{ candidateId: "T1", disposition: "included", topicIds: ["T1"], reason: "Самостоятельный разговор" }] };
    };
    const part = raw(); part.topics = [part.topics[0], { ...part.topics[0], id: "ignored", title: "Второй эпизод" }];
    const args = [[part], "Олег", "ru", undefined, ["-m", "gpt-6-astra"], []];
    const result = await analyzer.consolidate(...args);
    assert.equal(result.topics.length, 1); assert.equal(calls, 2);
    await analyzer.consolidate(...args); assert.equal(calls, 2);
    const base = JSON.parse(await readFile("schemas/context-analysis.schema.json", "utf8"));
    assert.equal(coverageSchema(base).properties.topics.maxItems, undefined);
    assert.equal(base.properties.decisions, undefined);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
