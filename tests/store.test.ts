import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AtomicStore } from "../electron/store.js";

test("identity starts unconfigured and explicit choices persist", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "family-bridge-store-test-"));
  try {
    const store = new AtomicStore(directory);
    const initial = await store.read();
    assert.equal(initial.identityConfigured, false);
    assert.equal(initial.language, "ru");

    await store.update({ owner: "katya", identityConfigured: true, language: "cs" });
    const persisted = await new AtomicStore(directory).read();
    assert.equal(persisted.owner, "katya");
    assert.equal(persisted.identityConfigured, true);
    assert.equal(persisted.language, "cs");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
