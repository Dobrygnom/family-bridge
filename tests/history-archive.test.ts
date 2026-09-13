import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { AtomicStore } from "../electron/store.js";
import { archiveConversationHistory } from "../electron/history-archive.js";

test("history archive is complete, readable, local and idempotent", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fb-history-archive-"));
  try {
    const store = new AtomicStore(dir);
    const state = await store.update({ owner: "dima", displayName: "Дмитрий", remote: { pairId: "pair", encryptionSecret: "DO_NOT_EXPORT", peerName: "Катя" },
      conversationTranscripts: { one: { topic: "Планы", messages: [{ from: "dima", text: "Старое сообщение" }, { from: "katya", text: "Новое сообщение", sentAt: "2026-09-13T10:00:00Z" }] } } });
    await archiveConversationHistory(dir, state, "1.2.36");
    await archiveConversationHistory(dir, state, "1.2.36");
    const entries = await readdir(path.join(dir, "history-archives"), { withFileTypes: true });
    const archive = entries.find(entry => entry.isDirectory())!;
    const markdown = await readFile(path.join(dir, "history-archives", archive.name, "history.md"), "utf8");
    const json = await readFile(path.join(dir, "history-archives", archive.name, "history.json"), "utf8");
    assert.match(markdown, /Старое сообщение/); assert.match(markdown, /Время неизвестно/); assert.match(markdown, /2026-09-13T10:00:00.000Z/);
    assert.doesNotMatch(json, /DO_NOT_EXPORT/);
    assert.equal(entries.filter(entry => entry.isDirectory()).length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
