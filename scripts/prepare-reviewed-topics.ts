// Stage an explicitly accepted preview. Apply separately, with the app closed,
// using rediscover-topics.ts apply and its live-state/hash guards.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { contextSourceHash, normalizeContextAnalysis, replaceUnreviewedSuggestions, type ContextAnalysis } from "../src/core/context-analysis.js";
import { shareableTopicBrief } from "../src/core/conversation-quality.js";
const [previewArg, snapshotArg, profileArg, outputArg] = process.argv.slice(2);
assert.ok(previewArg && snapshotArg && profileArg && outputArg);
const [previewDir, snapshot, profile, output] = [previewArg, snapshotArg, profileArg, outputArg].map(item => path.resolve(item));
assert.ok(output !== profile && !output.startsWith(profile + path.sep));
assert.ok(output !== snapshot && output !== previewDir);
const json = async (file: string) => JSON.parse(await readFile(file, "utf8"));
const memory = path.join(profile, "psychologist-memory");
const current = await json(path.join(memory, "context-analysis.json")) as ContextAnalysis;
const source = await json(path.join(memory, "context-source.json"));
const reviewedSource = await json(path.join(snapshot, "context-analysis.json"));
const preview = await json(path.join(previewDir, "preview.json"));
const samples = await readFile(path.join(snapshot, "style-samples.jsonl"), "utf8");
const messages = samples.trim().split(/\r?\n/).map(line => JSON.parse(line));
assert.equal(source.id, reviewedSource.sourceId);
assert.equal(current.sourceId, reviewedSource.sourceId);
assert.equal(current.sourceHash, contextSourceHash(messages), "Source changed since the accepted preview");
assert.equal(current.sourceHash, reviewedSource.sourceHash);
assert.equal(source.status, "ready"); assert.equal(current.status, "ready");
const normalize = (text: string) => text.normalize("NFKC").trim().toLocaleLowerCase();
const rawTopics = preview.topics.map((topic: any) => {
  const recipients = current.people.filter(person => [person.label, ...person.aliases].some(name => normalize(name) === normalize(topic.recipient)));
  assert.equal(recipients.length, 1, `Recipient is ambiguous: ${topic.recipient}`);
  for (const field of ["context", "goal", "openingQuestion"]) assert.ok(typeof topic[field] === "string" && topic[field].trim() && topic[field].length <= 800, `Invalid ${field}`);
  assert.ok(["current", "check_relevance"].includes(topic.relevance));
  return { title: topic.title, about_people: [recipients[0].id], discuss_with: recipients[0].id, sensitivity: "direct" as const, relevance: topic.relevance,
    reason: `Контекст: ${topic.context} Что хотим понять: ${topic.goal} Начало разговора: ${topic.openingQuestion}` };
});
const normalized = normalizeContextAnalysis({ people: current.people.map(person => ({ key: person.id, label: person.label, relationship: person.relationship, aliases: person.aliases })), topics: rawTopics }, source.id, current.sourceHash);
for (let i = 0; i < normalized.topics.length; i++) {
  assert.deepEqual(shareableTopicBrief(normalized.topics[i]), { context: preview.topics[i].context, goal: preview.topics[i].goal, openingQuestion: preview.topics[i].openingQuestion });
}
const candidate = replaceUnreviewedSuggestions({ ...current, topics: normalized.topics, analyzedAt: new Date().toISOString() }, current);
await mkdir(output, { recursive: false });
const names = ["context-source.json", "context-analysis.json", "style-samples.jsonl"];
const hashes = async () => Object.fromEntries(await Promise.all(names.map(async name => [name, createHash("sha256").update(await readFile(path.join(memory, name))).digest("hex")])));
const baseline = await hashes();
await cp(memory, path.join(output, "before"), { recursive: true });
assert.deepEqual(await hashes(), baseline);
await writeFile(path.join(output, "baseline.json"), JSON.stringify(baseline));
await writeFile(path.join(output, "context-analysis.json"), JSON.stringify(candidate, null, 2));
await writeFile(path.join(output, "context-source.json"), JSON.stringify(source, null, 2));
await writeFile(path.join(output, "style-samples.jsonl"), samples);
await cp(path.join(snapshot, "analysis-cache"), path.join(output, "analysis-cache"), { recursive: true });
await cp(path.join(previewDir, "preview.json"), path.join(output, "accepted-preview.json"));
console.log(JSON.stringify({ stage: "accepted-preview-staged-not-applied", topics: candidate.topics.length, protected: candidate.topics.length - normalized.topics.length, approved: candidate.topics.filter(t => t.approved).length, grouped: Object.fromEntries(current.people.map(p => [p.id, candidate.topics.filter(t => t.discussWithPersonId === p.id).length]).filter(([, n]) => n)), output }));
