import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RuntimeDiagnostics } from "../electron/runtime-diagnostics.js";
import { sanitizeSupportReport, supportErrorCode } from "../electron/support-report.js";
import { RemoteSupport } from "../electron/remote-support.js";

test("sleep and resume survive the heartbeat, while a timer gap alone does not assert sleep", () => {
  let now = 1_000;
  const runtime = new RuntimeDiagnostics(() => now);
  runtime.power("suspend"); now += 600_000;
  let state = runtime.snapshot();
  assert.equal(state.powerState, "suspended");
  assert.deepEqual(state.events.map(e => e.event), ["suspend", "timer-gap"]);
  assert.equal(state.events[1].elapsedMs, 600_000);
  runtime.power("resume"); now += 5_000;
  assert.equal(runtime.snapshot().events.length, 3);
  assert.equal(runtime.snapshot().powerState, "resumed");
  const unknown = new RuntimeDiagnostics(() => now); now += 90_000;
  assert.equal(unknown.snapshot().powerState, "unknown");
  for (let n = 0; n < 40; n++) { now += 30_000; unknown.sample(); }
  assert.equal(unknown.snapshot().events.length, 24);
});

test("remote runtime evidence keeps failure stage after recovery and excludes arbitrary data", () => {
  let now = Date.now(); const runtime = new RuntimeDiagnostics(() => now);
  runtime.begin("dialogue", "pair"); now += 400;
  runtime.stage("dialogue", "receive"); now += 15_000;
  runtime.fail("dialogue", supportErrorCode(new DOMException("private detail", "TimeoutError")));
  runtime.end("dialogue"); runtime.begin("dialogue", "pair");
  const safe = sanitizeSupportReport({ schema: 1, at: new Date(now).toISOString(), bootId: randomUUID(), status: {}, update: {}, events: [],
    runtimeDiagnostics: { ...runtime.snapshot(), token: "secret", operations: runtime.snapshot().operations.map(op => ({ ...op, message: "secret" })) } });
  const op = safe!.runtimeDiagnostics!.operations[0];
  assert.equal(op.code, "ETIMEDOUT"); assert.equal(op.failureStage, "receive");
  assert.equal(op.lastDurationMs, 15_400); assert.equal(op.busy, true);
  assert.doesNotMatch(JSON.stringify(safe), /secret|private detail|token/);
  assert.equal(supportErrorCode(new DOMException("", "AbortError")), "ABORTED");
});

test("a pending support read exposes its stage without blocking diagnostics", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fb-runtime-"));
  let now = Date.now(), reject!: (error: unknown) => void, entered!: () => void;
  const reading = new Promise<void>(resolve => entered = resolve);
  const runtime = new RuntimeDiagnostics(() => now);
  const report = () => ({ schema: 1 as const, at: new Date(now).toISOString(), bootId: randomUUID(), status: {}, update: {}, events: [], runtimeDiagnostics: runtime.snapshot() });
  const support = new RemoteSupport(dir, { runtime, snapshot: async () => report(), record: () => {}, update: () => {},
    context: async () => ({ pairId: "pair", me: "me", peer: "peer", owner: "dima", transport: {
      readSupportMessages: () => { entered(); return new Promise((_resolve, fail) => reject = fail); },
    } as any }) }, () => now);
  try {
    const task = support.tick(); await reading; now += 12_000;
    const op = (await support.status()).local.runtimeDiagnostics!.operations[0];
    assert.equal(op.stage, "receive"); assert.equal(op.stageElapsedMs, 12_000); assert.equal(op.busy, true);
    reject(new DOMException("", "TimeoutError")); await task;
    const done = (await support.status()).local.runtimeDiagnostics!.operations[0];
    assert.equal(done.busy, false); assert.equal(done.code, "ETIMEDOUT");
  } finally { support.stop(); await rm(dir, { recursive: true, force: true }); }
});
