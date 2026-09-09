import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BackgroundService } from "../electron/background-service.js";
import { AtomicStore } from "../electron/store.js";
import { contextSourceHash } from "../src/core/context-analysis.js";

for (const scenario of ["recover", "repeat-failure", "wrong-hash"] as const) {
  test(`saved coverage failure recovery: ${scenario}`, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fb-coverage-recovery-"));
    try {
      const messages = [{ text: "Saved source, no browser access needed" }];
      const topics = [{ id: "selected", title: "My edited title", approved: true }];
      const memory = path.join(dir, "psychologist-memory");
      await mkdir(memory);
      await writeFile(path.join(memory, "style-samples.jsonl"), messages.map(message => JSON.stringify(message)).join("\n"));
      await writeFile(path.join(memory, "context-source.json"), JSON.stringify({ id: "chat", status: "error" }));
      await writeFile(path.join(memory, "context-analysis.json"), JSON.stringify({
        sourceId: "chat", sourceHash: scenario === "wrong-hash" ? "mismatch" : contextSourceHash(messages),
        status: "error", people: [], topics, error: "Every candidate needs exactly one disposition + actual - expected",
      }));
      const store = new AtomicStore(dir);
      await store.update({ onboardingComplete: true, pairTopics: ["My edited title"] });
      const service = new BackgroundService(dir, process.cwd(), store, () => null, undefined, { backgroundTasks: false }) as any;
      let exports = 0, analyses = 0;
      service.listContextThreads = async () => { exports++; throw new Error("Must not export source"); };
      service.analyzeContext = async (id: string, hash: string, cached: unknown, previous: any) => {
        analyses++;
        assert.equal(id, "chat"); assert.equal(hash, contextSourceHash(messages));
        assert.deepEqual(cached, messages); assert.deepEqual(previous.topics, topics);
        assert.equal(previous.coverageRecoveryAttempted, true);
        if (scenario === "repeat-failure") throw new Error("Temporarily unavailable");
        await service.writeContextAnalysis({ ...previous, status: "ready", error: undefined });
      };
      await service.checkContextForUpdates();
      assert.equal(exports, 0);
      assert.equal(analyses, scenario === "wrong-hash" ? 0 : 1);
      assert.equal(service.contextSyncing, false);
      assert.deepEqual(service.localContextState().contextAnalysis.topics, topics);
      assert.deepEqual((await store.read()).pairTopics, ["My edited title"]);
      if (scenario === "recover") assert.equal(service.localContextState().context.status, "ready");
      if (scenario === "repeat-failure") {
        service.lastContextCheckAt = 0;
        await service.checkContextForUpdates();
        assert.equal(analyses, 1); assert.equal(exports, 0);
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}
