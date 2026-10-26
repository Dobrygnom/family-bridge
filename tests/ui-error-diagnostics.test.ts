import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { UiErrorDiagnostics } from "../electron/ui-error-diagnostics.js";

test("visible UI errors and their clearance persist without storing displayed text", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fb-ui-errors-"));
  try {
    const tracker = new UiErrorDiagnostics(dir), first = randomUUID(), changed = randomUUID();
    await tracker.record({ visible: true, visibleCount: 1, occurrenceId: first, text: "PRIVATE ERROR TEXT" });
    await tracker.record({ visible: true, visibleCount: 2, occurrenceId: changed });
    await tracker.record({ visible: false, visibleCount: 0 });
    const restored = await new UiErrorDiagnostics(dir).snapshot();
    assert.equal(restored.totalShown, 1);
    assert.equal(restored.currentlyVisible, false);
    assert.deepEqual(restored.recent.map(row => row.state), ["shown", "updated", "cleared"]);
    assert.doesNotMatch(JSON.stringify(restored), /PRIVATE ERROR TEXT/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("malformed renderer telemetry is ignored", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fb-ui-errors-"));
  try {
    const tracker = new UiErrorDiagnostics(dir);
    await tracker.record({ visible: true, visibleCount: 1, occurrenceId: "not-a-uuid" });
    await tracker.record({ visible: true, visibleCount: 1000, occurrenceId: randomUUID() });
    assert.equal((await tracker.snapshot()).totalShown, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("renderer diagnostic snapshot persists counters but never draft contents", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fb-ui-state-"));
  try {
    const tracker = new UiErrorDiagnostics(dir);
    await tracker.recordRenderer({ onboardingComplete: true, analysisStatus: "ready", activeSection: "reports", focused: true, visible: true,
      draftKeys: 3, draftCharacters: 412, readingMarkers: 19, draftText: "PRIVATE DRAFT" });
    const snapshot = await new UiErrorDiagnostics(dir).snapshot();
    assert.equal(snapshot.renderer?.activeSection, "reports");
    assert.equal(snapshot.renderer?.draftCharacters, 412);
    assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE DRAFT|draftText/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a new application session clears stale current visibility without deleting history", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fb-ui-errors-session-"));
  try {
    const first = new UiErrorDiagnostics(dir);
    await first.record({ visible: true, visibleCount: 1, occurrenceId: randomUUID() });
    const restarted = new UiErrorDiagnostics(dir);
    await restarted.record({ visible: false, visibleCount: 0 });
    const snapshot = await restarted.snapshot();
    assert.equal(snapshot.totalShown, 1);
    assert.equal(snapshot.currentlyVisible, false);
    assert.equal(snapshot.visibleCount, 0);
    assert.deepEqual(snapshot.recent.map(row => row.state), ["shown", "cleared"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
