import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

test("readable archive stitches inherited report snapshots without losing raw reports", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fb-history-stitch-"));
  try {
    const reportsDir = path.join(dir, "reports"); await mkdir(reportsDir);
    const root = path.join(reportsDir, "root.json"), child = path.join(reportsDir, "child.json");
    await writeFile(root, JSON.stringify({ conversationId:"root", topic:"Тема", messages:[{from:"dima",text:"Один"},{from:"katya",text:"Два"}] }));
    await writeFile(child, JSON.stringify({ conversationId:"child", parentReportId:"root", inheritedMessageCount:2, topic:"Тема", messages:[{from:"dima",text:"Один"},{from:"katya",text:"Два"},{from:"dima",text:"Три"}] }));
    const store = new AtomicStore(dir), state = await store.update({ reports:[child,root], conversationParents:{live:"child"}, conversationInheritedCounts:{live:3},
      conversationTranscripts:{live:{topic:"Тема",messages:[{from:"dima",text:"Один"},{from:"katya",text:"Два"},{from:"dima",text:"Три"},{from:"katya",text:"Четыре"}]}} });
    await archiveConversationHistory(dir,state,"1.2.37");
    const archive = (await readdir(path.join(dir,"history-archives"),{withFileTypes:true})).find(entry=>entry.isDirectory())!;
    const markdown = await readFile(path.join(dir,"history-archives",archive.name,"history.md"),"utf8");
    assert.equal((markdown.match(/Один/g) ?? []).length,1); assert.equal((markdown.match(/Два/g) ?? []).length,1); assert.equal((markdown.match(/Три/g) ?? []).length,1); assert.equal((markdown.match(/Четыре/g) ?? []).length,1);
    assert.equal((await readdir(path.join(dir,"history-archives",archive.name,"reports"))).length,2);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
