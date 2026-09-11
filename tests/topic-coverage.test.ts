import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexContextAnalyzer, normalizeContextAnalysis } from "../src/core/context-analysis.js";
import { coverageSchema, validateCoverage, selectionEvidence, topicCoverageRules, dialogueGroupingPrompt, type CoverageAnalysis } from "../src/core/topic-coverage.js";
import { shareableTopicBrief } from "../src/core/conversation-quality.js";
import { topicNeedsReview, topicRelevanceLabel } from "../src/core/topic-review.js";
import { createHash } from "node:crypto";

const raw = (): CoverageAnalysis => ({ people: [{ key: "peer", label: "Нина", relationship: "партнёр", aliases: [] }], portraits: [],
  topics: [{ id: "T1", title: "Незакрытый вопрос", about_people: ["peer"], discuss_with: "peer", sensitivity: "direct", relevance: "check_relevance", reason: `Контекст: ${"а".repeat(650)} Что хотим понять: Понять. Начало разговора: Я хотел понять нашу разницу. Как ты смотришь на это?` }],
  decisions: [{ candidateId: "C1", disposition: "included", topicIds: ["T1"], reason: "Нерешённый вопрос" }, { candidateId: "C2", disposition: "merged", topicIds: ["T1"], reason: "Другой эпизод того же вопроса" }],
});
const inputs = [{ id: "C1", discuss_with: "peer" }, { id: "C2", discuss_with: "peer" }];

test("all candidates already saved is success, not an empty grouping request", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "fb-empty-coverage-"));
  try {
    const analyzer = new CodexContextAnalyzer("unused", workspace, path.resolve("schemas/context-analysis.schema.json")) as any;
    let calls = 0;
    analyzer.run = async () => { calls++; return { ...raw(), topics: [], decisions: [{ candidateId: "C1", disposition: "excluded", topicIds: [], reason: "Уже есть сохранённая тема" }] }; };
    const previous = normalizeContextAnalysis(raw(), "source", "hash");
    previous.topics[0].approved = true;
    previous.topics[0].title = "Моя уточнённая тема";
    const selected = await analyzer.consolidate([raw()], "Олег", "ru", undefined, [], [], previous.topics);
    assert.equal(calls, 1);
    assert.deepEqual(selected.topics, []);
    const result = normalizeContextAnalysis(selected, "source", "hash", previous);
    assert.deepEqual(result.topics, previous.topics);
    const empty = await analyzer.consolidate([{ ...raw(), topics: [] }], "Олег", "ru", undefined, [], []);
    assert.equal(calls, 1);
    assert.deepEqual(empty.people, raw().people);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("grouping receives selected topics without excluded candidate decisions", () => {
  const input = raw(); input.decisions.push({ candidateId: "EXCLUDED_PRIVATE_ID", disposition: "excluded", topicIds: [], reason: "OLD_DECISION_ONLY" });
  const prompt = dialogueGroupingPrompt(input, "Олег", "ru", []);
  assert.doesNotMatch(prompt, /EXCLUDED_PRIVATE_ID|OLD_DECISION_ONLY/);
  assert.match(prompt, /Незакрытый вопрос/);
});

test("invalid historical coverage cache is regenerated and new invalid results are not cached", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "fb-invalid-coverage-"));
  try {
    const schema = path.resolve("schemas/context-analysis.schema.json");
    const analyzer = new CodexContextAnalyzer("unused", workspace, schema) as any;
    const key = createHash("sha256").update(JSON.stringify({ prompt: "prompt", modelArgs: [] })).digest("hex");
    const file = path.join(workspace, `analysis-${key}.json`);
    const invalid = { ...raw(), decisions: [] };
    await writeFile(file, JSON.stringify(invalid));
    let calls = 0;
    analyzer.run = async () => { calls++; return raw(); };
    await analyzer.runCached("prompt", [], [], schema, (result: CoverageAnalysis) => validateCoverage(result, inputs));
    assert.equal(calls, 1);
    validateCoverage(JSON.parse(await readFile(file, "utf8")), inputs);
    analyzer.run = async () => invalid;
    await assert.rejects(analyzer.coverageStage("bad", [], schema, inputs), /Сохранённые темы не изменены/);
    assert.equal((await readdir(workspace)).filter(name => name.startsWith("analysis-")).length, 1);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

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
      // Real failure: grouping keeps valid recipient keys but omits people.
      return { ...raw(), people: [], decisions: [{ candidateId: "T1", disposition: "included", topicIds: ["T1"], reason: "Самостоятельный разговор" }] };
    };
    const part = raw(); part.topics = [part.topics[0], { ...part.topics[0], id: "ignored", title: "Второй эпизод" }];
    const args = [[part], "Олег", "ru", undefined, ["-m", "gpt-6-astra"], []];
    const result = await analyzer.consolidate(...args);
    assert.equal(result.topics.length, 1); assert.equal(calls, 2);
    assert.deepEqual(result.people, raw().people);
    const previous = normalizeContextAnalysis(raw(), "source", "old");
    previous.topics[0] = { ...previous.topics[0], id: "discussed-topic", title: "Уже обсудили", reason: "Сохранённые договорённости", approved: true };
    const refreshed = normalizeContextAnalysis(result, "source", "new", previous);
    assert.deepEqual(refreshed.topics.slice(0, previous.topics.length), previous.topics);
    assert.equal(refreshed.topics.length, previous.topics.length + 1);
    assert.equal(refreshed.topics.at(-1)?.approved, false);
    await analyzer.consolidate(...args); assert.equal(calls, 2);
    const base = JSON.parse(await readFile("schemas/context-analysis.schema.json", "utf8"));
    assert.equal(coverageSchema(base).properties.topics.maxItems, undefined);
    assert.equal(base.properties.decisions, undefined);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("grouping rejects changed recipients with safe diagnostics and does not retry process failures", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "fb-grouping-errors-"));
  try {
    const diagnostics: unknown[] = [];
    const analyzer = new CodexContextAnalyzer("unused", workspace, path.resolve("schemas/context-analysis.schema.json"), event => diagnostics.push(event)) as any;
    const registry = raw();
    registry.people.push({ key: "other", label: "Другой человек", aliases: [], relationship: "" });
    analyzer.run = async () => { const result = raw(); result.topics[0].discuss_with = "other"; return result; };
    await assert.rejects(analyzer.coverageStage("grouping", [], analyzer.schemaPath, inputs, true, registry), (error: any) => error.issue === "COVERAGE_RECIPIENT_CHANGED");
    assert.deepEqual(diagnostics, [1, 2].map(current => ({ stage: "grouping", code: "COVERAGE_RECIPIENT_CHANGED", current, total: 2 })));
    let calls = 0;
    analyzer.run = async () => { calls++; throw new Error("Process unavailable"); };
    await assert.rejects(analyzer.coverageStage("process", [], analyzer.schemaPath, inputs), /Process unavailable/);
    assert.equal(calls, 1);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
