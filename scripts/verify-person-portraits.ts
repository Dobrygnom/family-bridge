import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexContextAnalyzer, contextSourceHash } from "../src/core/context-analysis.js";
import { defaultCodexCommand } from "../src/core/codex-runtime.js";

const userData = process.env.FAMILY_BRIDGE_USER_DATA || path.join(process.env.APPDATA || "", "family-bridge");
const memoryRoot = path.join(userData, "psychologist-memory");
const source = JSON.parse(await readFile(path.join(memoryRoot, "context-source.json"), "utf8")) as { id?: string; title?: string; project?: string };
const stored = JSON.parse(await readFile(path.join(userData, "state.json"), "utf8")) as { displayName?: string; language?: string };
const messages = (await readFile(path.join(memoryRoot, "style-samples.jsonl"), "utf8"))
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line) as { text?: string })
  .flatMap((item) => typeof item.text === "string" && item.text.trim() ? [{ text: item.text }] : []);

assert.ok(source.id, "Selected source chat is missing");
assert.ok(messages.length, "Selected source chat has no saved user messages");
const workspace = await mkdtemp(path.join(os.tmpdir(), "family-bridge-portrait-check-"));
try {
  const analyzer = new CodexContextAnalyzer(defaultCodexCommand(), workspace, path.resolve("schemas/context-analysis.schema.json"));
  const analysis = await analyzer.analyze({
    sourceId: source.id,
    sourceHash: contextSourceHash(messages),
    ownerName: stored.displayName || "Вы",
    language: stored.language || "ru",
    messages,
  });
  const portraits = analysis.portraits ?? [];
  assert.equal(portraits.length, analysis.people.length + 1, "Portraits must cover the owner and every detected person");
  assert.equal(portraits.filter((portrait) => portrait.isOwner).length, 1, "Exactly one owner portrait is required");
  assert.ok(portraits.find((portrait) => portrait.isOwner)?.observations.length, "Owner portrait is empty");
  assert.equal(new Set(portraits.map((portrait) => portrait.personId)).size, portraits.length, "Portrait person ids are not unique");
  assert.ok(portraits.every((portrait) => portrait.observations.every((item) => item.text.length <= 500)), "An observation is too long");
  if (process.env.FAMILY_BRIDGE_PORTRAIT_OUTPUT) {
    await writeFile(process.env.FAMILY_BRIDGE_PORTRAIT_OUTPUT, JSON.stringify(analysis, null, 2), "utf8");
  }
  console.log(JSON.stringify({
    verified: true,
    source: `${source.project || ""} · ${source.title || ""}`.trim(),
    messages: messages.length,
    people: analysis.people.length,
    portraits: portraits.map((portrait) => ({ label: portrait.label, owner: portrait.isOwner, observations: portrait.observations.length })),
  }));
} finally {
  await rm(workspace, { recursive: true, force: true });
}
