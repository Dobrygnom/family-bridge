import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AtomicStore } from "../electron/store.js";

test("identity starts unconfigured and an explicit display name persists", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "family-bridge-store-test-"));
  try {
    const store = new AtomicStore(directory);
    const initial = await store.read();
    assert.equal(initial.identityConfigured, false);
    assert.equal(initial.onboardingComplete, false);
    assert.equal(initial.displayName, "");
    assert.equal(initial.language, "ru");
    assert.deepEqual(initial.inFlightTopics, []);
    assert.deepEqual(initial.pairTopics, []);
    assert.deepEqual(initial.activeTopics, []);
    assert.deepEqual(initial.conversationTranscripts, {});

    await store.update({ owner: "katya", identityConfigured: true, displayName: "Катя", language: "cs" });
    const persisted = await new AtomicStore(directory).read();
    assert.equal(persisted.owner, "katya");
    assert.equal(persisted.identityConfigured, true);
    assert.equal(persisted.displayName, "Катя");
    assert.equal(persisted.language, "cs");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("parallel state updates do not overwrite each other", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "family-bridge-store-race-"));
  try {
    const store = new AtomicStore(directory);
    await Promise.all([
      store.update({ displayName: "Дмитрий" }),
      store.update({ language: "cs" }),
      store.update({ pairTopics: ["Тема"] }),
    ]);
    const state = await store.read();
    assert.equal(state.displayName, "Дмитрий");
    assert.equal(state.language, "cs");
    assert.deepEqual(state.pairTopics, ["Тема"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
