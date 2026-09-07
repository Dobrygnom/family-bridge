import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CONTEXT_ANALYSIS_VERSION, CodexContextAnalyzer, contextSourceHash, replaceUnreviewedSuggestions, type ContextAnalysis } from "../src/core/context-analysis.js";
import { CodexAppHistoryClient } from "../src/core/codex-app-history.js";
import { CodexHistoryClient } from "../src/core/codex-history.js";
import { preferredCodexModel } from "../src/core/codex-model.js";
import { defaultCodexCommand } from "../src/core/codex-runtime.js";
import { shareableTopicBrief } from "../src/core/conversation-quality.js";
import { replaceStateFile } from "../electron/store.js";

// A deliberately separate prepare/apply workflow: no service start, transport,
// queue changes or sharing. Close the app before apply to avoid concurrent writes.
const [mode, profileArg, workspaceArg] = process.argv.slice(2);
assert.ok(["prepare", "apply"].includes(mode) && profileArg && workspaceArg, "Usage: rediscover-topics.ts prepare|apply <profile> <private-workspace>");
const profile = path.resolve(profileArg);
const workspace = path.resolve(workspaceArg);
assert.ok(workspace !== profile && !workspace.startsWith(profile + path.sep), "Use a separate private workspace");
const memory = path.join(profile, "psychologist-memory");
const names = ["context-source.json", "context-analysis.json", "style-samples.jsonl"];
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const snapshot = async () => Object.fromEntries(await Promise.all(names.map(async (name) => [name, digest(await readFile(path.join(memory, name), "utf8"))])));

if (mode === "prepare") {
  await mkdir(workspace, { recursive: false });
  const baseline = await snapshot();
  await cp(memory, path.join(workspace, "before"), { recursive: true });
  assert.deepEqual(await snapshot(), baseline, "Context changed while creating the backup; retry with a new workspace");
  await writeFile(path.join(workspace, "baseline.json"), JSON.stringify(baseline));
  const source = JSON.parse(await readFile(path.join(memory, names[0]), "utf8"));
  const previous = JSON.parse(await readFile(path.join(memory, names[1]), "utf8")) as ContextAnalysis;
  const state = JSON.parse(await readFile(path.join(profile, "state.json"), "utf8"));
  assert.equal(source.id, previous.sourceId, "Selected source and analysis differ");
  const command = defaultCodexCommand();
  const model = await preferredCodexModel(command);
  assert.equal(model, "gpt-6-astra", "Astra must be available for this explicit reanalysis");
  console.log(JSON.stringify({ stage: "exporting", model, previousTopics: previous.topics.length }));
  const history = new CodexHistoryClient(command);
  const callingThread = source.source === "chatgpt" ? (await history.listThreads())[0]?.id : undefined;
  assert.ok(source.source !== "chatgpt" || callingThread, "No Codex Desktop task for chat export");
  const messages = source.source === "chatgpt"
    ? await new CodexAppHistoryClient(callingThread!).readUserMessages(source.id)
    : await history.readUserMessages(source.id);
  assert.ok(messages.length, "The exported chat is empty");
  console.log(JSON.stringify({ stage: "exported", messages: messages.length }));
  await writeFile(path.join(workspace, "style-samples.jsonl"), messages.map((message) => JSON.stringify(message)).join("\n") + "\n");
  const analyzer = new CodexContextAnalyzer(command, path.join(workspace, "analysis-cache"), path.resolve("schemas/context-analysis.schema.json"));
  const analysis = await analyzer.analyze({ sourceId: source.id, sourceHash: contextSourceHash(messages), ownerName: state.displayName || "Вы", language: state.language || "ru", messages,
    previous: { ...previous, topics: [] },
    onProgress: (progress) => { console.log(JSON.stringify({ operation: "analysis", ...progress })); },
  });
  assert.equal(analysis.model, model, "The analysis did not use the requested model");
  assert.ok(analysis.topics.length, "No topics found; inspect before replacing anything");
  assert.ok(analysis.topics.every((topic) => {
    const brief = shareableTopicBrief(topic);
    return !topic.approved && brief?.context && brief.goal && brief.openingQuestion;
  }), "Each proposal needs context, intent and a conversational opening");
  const candidate = replaceUnreviewedSuggestions(analysis, previous);
  await writeFile(path.join(workspace, "context-analysis.json"), JSON.stringify(candidate, null, 2));
  await writeFile(path.join(workspace, "context-source.json"), JSON.stringify({ ...source, status: "ready", error: undefined, messageCount: messages.length, lastSyncedAt: new Date().toISOString() }, null, 2));
  console.log(JSON.stringify({ stage: "prepared-not-applied", model, messages: messages.length, topics: candidate.topics.length, approved: candidate.topics.filter((topic) => topic.approved).length, workspace }));
} else {
  const baseline = JSON.parse(await readFile(path.join(workspace, "baseline.json"), "utf8"));
  assert.deepEqual(await snapshot(), baseline, "Source or topics changed during analysis; refusing to overwrite newer edits");
  const state = JSON.parse(await readFile(path.join(profile, "state.json"), "utf8"));
  assert.ok(!state.activeTopics?.length && !state.inFlightTopics?.length, "Wait for active conversations before applying");
  const candidate = JSON.parse(await readFile(path.join(workspace, "context-analysis.json"), "utf8")) as ContextAnalysis;
  assert.equal(candidate.status, "ready");
  assert.equal(candidate.analysisVersion, CONTEXT_ANALYSIS_VERSION);
  assert.equal(candidate.model, "gpt-6-astra");
  assert.equal(candidate.sourceId, JSON.parse(await readFile(path.join(memory, "context-source.json"), "utf8")).id);
  const exported = (await readFile(path.join(workspace, "style-samples.jsonl"), "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(candidate.sourceHash, contextSourceHash(exported), "The result does not belong to this export");
  assert.equal(JSON.parse(await readFile(path.join(workspace, "context-source.json"), "utf8")).messageCount, exported.length);
  const previous = JSON.parse(await readFile(path.join(memory, "context-analysis.json"), "utf8")) as ContextAnalysis;
  for (const topic of previous.topics.filter((item) => item.approved || item.sourceTitles?.length)) {
    assert.deepEqual(candidate.topics.find((item) => item.id === topic.id), topic, "A saved choice or clarification changed");
  }
  await cp(path.join(profile, "state.json"), path.join(workspace, "before-state.json"));
  // Leave state.json, approvals on protected topics, pairing and results untouched.
  for (const name of ["style-samples.jsonl", "context-source.json", "context-analysis.json"]) {
    const contents = await readFile(path.join(workspace, name));
    const destination = path.join(memory, name);
    await writeFile(destination + ".rediscovery.tmp", contents);
    await replaceStateFile(destination + ".rediscovery.tmp", destination);
  }
  // Keep the completed fragment work for the app's next incremental sync.
  await cp(path.join(workspace, "analysis-cache"), path.join(profile, "context-analysis"), { recursive: true });
  assert.equal(await readFile(path.join(profile, "state.json"), "utf8"), await readFile(path.join(workspace, "before-state.json"), "utf8"), "App state changed during apply; verify before restarting");
  console.log(JSON.stringify({ stage: "applied-locally", model: candidate.model, topics: candidate.topics.length, approved: candidate.topics.filter((topic) => topic.approved).length, backup: path.join(workspace, "before") }));
}
