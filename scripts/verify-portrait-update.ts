import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultCodexCommand } from "../src/core/codex-runtime.js";
import { CodexPortraitUpdater, type PersonPortrait } from "../src/core/person-portraits.js";

const workspace = await mkdtemp(path.join(os.tmpdir(), "family-bridge-portrait-update-"));
const now = "2026-09-04T08:00:00.000Z";
const portraits: PersonPortrait[] = [
  { personId: "owner", label: "Дмитрий", relationship: "", isOwner: true, observations: [], updatedAt: now },
  { personId: "katya", label: "Катя", relationship: "супруга", isOwner: false, observations: [], updatedAt: now },
];

try {
  const updater = new CodexPortraitUpdater(defaultCodexCommand(), workspace, path.resolve("schemas/portrait-updates.schema.json"));
  const updated = await updater.update({
    portraits,
    participants: [{ personId: "owner", label: "Дмитрий" }, { personId: "katya", label: "Катя" }],
    topic: "Как проводить выходные",
    conversationId: "verification-conversation",
    language: "русский",
    completedAt: now,
    messages: [
      { personId: "owner", speaker: "Дмитрий", text: "Мне важно хотя бы один выходной заранее планировать вместе, иначе я чувствую, что мы просто разъезжаемся каждый по своим делам." },
      { personId: "katya", speaker: "Катя", text: "А мне важно не планировать все выходные заранее. Я готова заранее выбрать один совместный день, если второй останется свободным." },
      { personId: "owner", speaker: "Дмитрий", text: "Один общий день и один свободный мне подходит." },
      { personId: "katya", speaker: "Катя", text: "Тогда давай по средам выбирать, какой день следующий общий." },
    ],
  });
  assert.equal(updated.length, 2);
  for (const portrait of updated) {
    const additions = portrait.observations.filter((item) => item.sourceType === "conversation");
    assert.ok(additions.length > 0, `${portrait.label} did not receive a conversation observation`);
    assert.ok(additions.every((item) => item.sourceId === "verification-conversation"));
    assert.ok(additions.every((item) => item.sourceLabel === "Как проводить выходные"));
  }
  assert.ok(updated.every((portrait) => portrait.personId === "owner" || portrait.personId === "katya"));
  console.log(JSON.stringify({
    verified: true,
    portraits: updated.map((portrait) => ({ label: portrait.label, added: portrait.observations.filter((item) => item.sourceType === "conversation").length })),
  }));
} finally {
  await rm(workspace, { recursive: true, force: true });
}
