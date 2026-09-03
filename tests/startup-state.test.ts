import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BackgroundService } from "../electron/background-service.js";
import { AtomicStore } from "../electron/store.js";

test("saved onboarding and ready analysis open without waiting for Codex or an unreachable partner", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fb-startup-"));
  try {
    const store = new AtomicStore(dir);
    await store.update({ onboardingComplete: true, pairTopics: ["Preserved"], remote: { pairId: "pair", encryptionSecret: "test" } });
    await mkdir(path.join(dir, "psychologist-memory"));
    await writeFile(path.join(dir, "psychologist-memory/context-source.json"), JSON.stringify({ id: "chat", status: "ready", messageCount: 498 }));
    const analysis = { sourceId: "chat", status: "ready", people: [{ id: "person" }], topics: [{ id: "topic", approved: true }] };
    await writeFile(path.join(dir, "psychologist-memory/context-analysis.json"), JSON.stringify(analysis));
    const service = new BackgroundService(dir, process.cwd(), store, () => null);
    (service as any).codexStatus = () => new Promise(() => undefined);
    (service as any).remote = { pairState: () => new Promise(() => undefined) };
    const started = Date.now();
    const snapshot = await Promise.race([service.state(), new Promise<never>((_, reject) => { const t = setTimeout(() => reject(new Error("Local state blocked on network")), 1000); t.unref(); })]);
    assert.ok(Date.now() - started < 1000);
    assert.equal(snapshot.onboardingComplete, true);
    assert.equal(snapshot.contextAnalysis?.status, "ready");
    assert.deepEqual(snapshot.pairTopics, ["Preserved"]);
    assert.equal(snapshot.context?.messageCount, 498);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("startup restores an existing profile without resetting selections, but a fresh profile still chooses a chat", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fb-profile-"));
  try {
    const store = new AtomicStore(dir);
    const service = new BackgroundService(dir, process.cwd(), store, () => null, undefined, { backgroundTasks: false });
    await service.start();
    const first = await service.state();
    assert.equal(first.onboardingComplete, false);
    assert.equal(first.context, undefined);
    await store.update({ onboardingComplete: true, pairTopics: ["topic-1", "topic-2"] });
    await service.start();
    const reopened = await service.state();
    assert.equal(reopened.onboardingComplete, true);
    assert.deepEqual(reopened.pairTopics, ["topic-1", "topic-2"]);
    const logs = await readFile(service.diagnostics.file, "utf8");
    assert.match(logs, /startup.saved-state/);
    assert.doesNotMatch(logs, /topic-1|topic-2/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("parallel analysis checkpoint writes cannot corrupt the final ready result", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fb-analysis-"));
  try {
    const service = new BackgroundService(dir, process.cwd(), new AtomicStore(dir), () => null, undefined, { backgroundTasks: false });
    const base = { sourceId: "test", people: [], topics: [] };
    await Promise.all([
      (service as any).writeContextAnalysis({ ...base, status: "analyzing", progress: { current: 1, total: 3 } }),
      (service as any).writeContextAnalysis({ ...base, status: "analyzing", progress: { current: 2, total: 3 } }),
      (service as any).writeContextAnalysis({ ...base, status: "ready", topics: [{ id: "saved" }] }),
    ]);
    assert.equal(service.localContextState().contextAnalysis?.status, "ready");
    assert.equal(service.localContextState().contextAnalysis?.topics[0].id, "saved");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("an unreadable state is never mistaken for a new install or overwritten by settings", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fb-corrupt-"));
  try {
    const file = path.join(dir, "state.json");
    await writeFile(file, "{broken but valuable data");
    const store = new AtomicStore(dir);
    await assert.rejects(store.read(), /Данные не сброшены/);
    await assert.rejects(store.update({ language: "en" }), /Данные не сброшены/);
    assert.equal(await readFile(file, "utf8"), "{broken but valuable data");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
