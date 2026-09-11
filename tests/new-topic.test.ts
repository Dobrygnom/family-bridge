import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { AtomicStore } from "../electron/store.js";
import { BackgroundService } from "../electron/background-service.js";
import { newTopicWireText } from "../src/core/new-topic.js";

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fb-new-topic-")), store = new AtomicStore(dir);
  await store.update({ identityConfigured: true, onboardingComplete: true, displayName: "Дмитрий", remote: { pairId: "pair", encryptionSecret: "test", peerName: "Катя" } });
  const prepared = { title: "Новый разговор", context: "Обстоятельства для Кати.", message: "Можно обсудить это?" };
  const sent: any[] = []; let prompt = "";
  const create = () => {
    const service = new BackgroundService(dir, process.cwd(), store, () => null, undefined,
      { backgroundTasks: false, newTopicComposer: async p => { prompt = p; return prepared; } });
    (service as any).state = () => store.read();
    (service as any).privateSourceExcerpts = () => "PRIVATE_ARCHIVE";
    (service as any).localRemoteAgent = () => assert.fail("The approved opening must never be regenerated");
    (service as any).remote = { pairState: async () => ({ id: "pair", owner_id: "one", partner_id: "two" }), identity: async () => "one",
      send: async (input: any) => { sent.push(input); return "sent"; } };
    return service;
  };
  return { dir, store, create, prepared, sent, prompt: () => prompt, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("agent preview does not publish or queue anything and approved context travels with the exact message", async () => {
  const f = await fixture();
  try {
    const service = f.create(), before = await f.store.read();
    const preview = await service.prepareNewTopic({ pairId: "pair", description: "PRIVATE_DESCRIPTION", instruction: "PRIVATE_EDIT" });
    assert.deepEqual(await f.store.read(), before); assert.equal(f.sent.length, 0);
    assert.match(f.prompt(), /PRIVATE_DESCRIPTION/); assert.match(f.prompt(), /PRIVATE_EDIT/);
    await service.sendNewTopic({ ...preview, pairId: "pair", id: randomUUID(), mode: "agent" });
    assert.equal(f.sent.length, 0, "Approval is saved before delivery");
    await (service as any).startRemoteConversation(preview.title);
    assert.equal(f.sent.length, 1); assert.equal(f.sent[0].payload.text, newTopicWireText(preview, "ru"));
    assert.doesNotMatch(JSON.stringify(f.sent), /PRIVATE/);
  } finally { await f.cleanup(); }
});

test("direct message keeps whitespace and context through a failed send, restart and duplicate approval", async () => {
  const f = await fixture();
  try {
    let service = f.create();
    const request = { id: randomUUID(), pairId: "pair", mode: "direct", title: "Дословный разговор", context: "Вчера:\n  важная деталь", message: "  Мои слова\n\nбез изменений.  " };
    await Promise.all([service.sendNewTopic(request), service.sendNewTopic(request)]);
    assert.equal(Object.keys((await f.store.read()).topicLaunches).length, 1);
    const send = (service as any).remote.send;
    (service as any).remote.send = async (input: any) => { await send(input); throw new Error("Network unavailable"); };
    await assert.rejects((service as any).startRemoteConversation(request.title));
    service = f.create(); await service.sendNewTopic(request);
    await (service as any).startRemoteConversation(request.title);
    await service.sendNewTopic(request); await (service as any).startRemoteConversation(request.title);
    assert.equal(f.sent.length, 2);
    for (const sent of f.sent) { assert.equal(sent.payload.text, newTopicWireText(request, "ru")); assert.equal(sent.idempotencyKey, `${request.id}:1`); assert.equal(sent.payload.origin, "owner-answer"); }
    assert.equal((await f.store.read()).conversationTranscripts[request.id].messages.length, 1);
  } finally { await f.cleanup(); }
});

test("changed recipient, duplicate topic and changing an accepted opening never overwrite a conversation", async () => {
  const f = await fixture();
  try {
    const service = f.create(), request = { ...f.prepared, id: randomUUID(), mode: "agent", pairId: "pair" };
    await service.sendNewTopic(request); const before = await f.store.read();
    await assert.rejects(service.sendNewTopic({ ...request, id: randomUUID() }), /уже есть/);
    await assert.rejects(service.sendNewTopic({ ...request, message: "Changed" }), /уже передан/);
    await assert.rejects(service.sendNewTopic({ ...request, pairId: "other" }), /Получатель/);
    await assert.rejects(service.prepareNewTopic({ pairId: "other", description: "Description" }), /Получатель/);
    assert.deepEqual(await f.store.read(), before); assert.equal(f.sent.length, 0);
  } finally { await f.cleanup(); }
});
