import assert from "node:assert/strict";
import test from "node:test";
import { CONTEXT_ANALYSIS_VERSION, contextAnalysisNeedsRefresh, normalizeContextAnalysis, routeSensitivity, splitContextMessages, topicsForCounterpart, type ContextAnalysis } from "../src/core/context-analysis.js";
import { contextSourceHash, replaceUnreviewedSuggestions, sourceThroughDate } from "../src/core/context-analysis.js";
import { buildDiscoveryPrompt, buildTopicSelectionPrompt } from "../src/core/topic-discovery-prompts.js";
import { shareableTopicBrief } from "../src/core/conversation-quality.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexContextAnalyzer } from "../src/core/context-analysis.js";

test("discovery cache cannot reuse results from a different model", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "family-bridge-discovery-cache-"));
  try {
    const analyzer = new CodexContextAnalyzer("unused", workspace, "unused") as unknown as { run: (prompt: string, model: string[]) => Promise<unknown>; runCached: (prompt: string, model: string[], legacy?: string[]) => Promise<unknown> };
    let calls = 0;
    analyzer.run = async (_prompt, model) => { calls++; return { model: model[1] }; };
    assert.deepEqual(await analyzer.runCached("same source", ["--model", "old"]), { model: "old" });
    assert.deepEqual(await analyzer.runCached("same source", ["--model", "gpt-6-astra"]), { model: "gpt-6-astra" });
    await analyzer.runCached("same source", ["--model", "gpt-6-astra"]);
    assert.equal(calls, 2);
    const dated = buildDiscoveryPrompt("Owner", "ru", "unchanged fragment", "2026-09-06");
    const stable = buildDiscoveryPrompt("Owner", "ru", "unchanged fragment");
    await analyzer.runCached(dated, ["--model", "gpt-6-astra"]);
    await analyzer.runCached(stable, ["--model", "gpt-6-astra"], [dated]);
    await analyzer.runCached(stable, ["--model", "gpt-6-astra"], [buildDiscoveryPrompt("Owner", "ru", "unchanged fragment", "2026-09-08")]);
    assert.equal(calls, 3, "A new snapshot date must not re-read an unchanged historical fragment");
    await analyzer.runCached(buildDiscoveryPrompt("Owner", "ru", "changed fragment"), ["--model", "gpt-6-astra"], [buildDiscoveryPrompt("Owner", "ru", "changed fragment", "2026-09-06")]);
    assert.equal(calls, 4, "Changed source content must be analyzed again");
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("discovery preserves dates on long fragments and hashes chronology", () => {
  const message = { text: "a".repeat(300), created_at: "2026-08-01T10:00:00Z" };
  const chunks = splitContextMessages([message], 100);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.includes("written_at=2026-08-01T10:00:00.000Z") && chunk.length <= 100));
  assert.equal(chunks.map((chunk) => chunk.slice(chunk.indexOf("] ") + 2)).join(""), message.text);
  assert.notEqual(contextSourceHash([message]), contextSourceHash([{ ...message, created_at: "2026-09-01T10:00:00Z" }]));
  assert.equal(sourceThroughDate([message, { text: "Unknown", created_at: "invalid" }]), "2026-08-01T10:00:00.000Z");
  assert.deepEqual(splitContextMessages([{ text: "  " }]), []);
});

test("discovery and selection retain evidence instead of prescribing a solution", () => {
  const discovery = buildDiscoveryPrompt("Owner", "en", "Old story", "2026-09-06");
  assert.match(discovery, /НЕ обязательно дата описанного события/);
  assert.match(discovery, /что противоречит первоначальному впечатлению/);
  const selection = buildTopicSelectionPrompt([], "Owner", "en", "2026-09-06");
  assert.match(selection, /Поздние уточнения меняют ранние выводы/);
  assert.match(selection, /Удали смысловые дубликаты/);
  assert.match(selection, /Не назначай ответ заранее/);
  assert.match(selection, /2–4 естественных предложения/);
  assert.match(selection, /не автоматически принятый кризисный план/);
  assert.match(selection, /Не добавляй позитивные темы ради квоты/);
  assert.doesNotMatch(selection, /Сохрани все различимые темы/);
});

test("natural topic sections deliver the complete opening while legacy topics still work", () => {
  const topic = { reason: "Контекст: Мы по-разному поняли встречу. Что хотим понять: Уточнить смысл ответа. Начало разговора: Я мог не так понять твоё сообщение. Ты имела в виду эту среду?" } as ContextAnalysis["topics"][number];
  assert.deepEqual(shareableTopicBrief(topic), { context: "Мы по-разному поняли встречу.", goal: "Уточнить смысл ответа.", openingQuestion: "Я мог не так понять твоё сообщение. Ты имела в виду эту среду?" });
  assert.equal(shareableTopicBrief({ ...topic, reason: "Наблюдаемая динамика: Старый контекст. Психологическая цель: Понять. Первый вопрос: Что ты думаешь?" })?.context, "Старый контекст.");
});

test("explicit rediscovery replaces only untouched suggestions and never approves generated topics", () => {
  const topic = (id: string, approved = false) => ({ id, title: id, reason: "Context", approved, aboutPersonIds: ["peer"], discussWithPersonId: "peer", sensitivity: "direct" as const });
  const saved = { analysisVersion: 4, sourceId: "chat", sourceHash: "old", analyzedAt: "", status: "ready", people: [], topics: [topic("old-suggestion"), topic("approved", true), { ...topic("edited"), sourceTitles: ["original"] }] } satisfies ContextAnalysis;
  const incoming = { ...saved, analysisVersion: CONTEXT_ANALYSIS_VERSION, topics: [topic("new", true), topic("original")] };
  const result = replaceUnreviewedSuggestions(incoming, saved);
  assert.deepEqual(result.topics.map((item) => item.title), ["approved", "edited", "new"]);
  assert.equal(result.topics[2].approved, false);
  assert.deepEqual(saved.topics.map((item) => item.title), ["old-suggestion", "approved", "edited"]);
  assert.throws(() => replaceUnreviewedSuggestions({ ...incoming, sourceId: "different" }, saved), /source changed/);
});

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
