import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { ConversationCoordinator } from "../src/core/coordinator.js";
import {
  PAIR_CREATOR_AGENT_ID,
  PAIR_JOINER_AGENT_ID,
  agentIdForRole,
  isAgentId,
  peerAgentId,
  roleForAgentId,
  type AgentRuntime,
} from "../src/core/types.js";

test("serialized participant tokens behave as generic pair roles", () => {
  assert.equal(agentIdForRole("creator"), PAIR_CREATOR_AGENT_ID);
  assert.equal(agentIdForRole("joiner"), PAIR_JOINER_AGENT_ID);
  assert.equal(roleForAgentId(PAIR_CREATOR_AGENT_ID), "creator");
  assert.equal(roleForAgentId(PAIR_JOINER_AGENT_ID), "joiner");
  assert.equal(peerAgentId(PAIR_CREATOR_AGENT_ID), PAIR_JOINER_AGENT_ID);
  assert.equal(peerAgentId(PAIR_JOINER_AGENT_ID), PAIR_CREATOR_AGENT_ID);
  assert.equal(isAgentId(PAIR_CREATOR_AGENT_ID), true);
  assert.equal(isAgentId(PAIR_JOINER_AGENT_ID), true);
  assert.equal(isAgentId("an arbitrary participant name"), false);
});

test("coordinator rejects runtimes assigned to the wrong pair roles", () => {
  const runtime = (id: typeof PAIR_CREATOR_AGENT_ID | typeof PAIR_JOINER_AGENT_ID): AgentRuntime => ({
    id,
    start: async () => { throw new Error("unused"); },
    respond: async () => { throw new Error("unused"); },
  });
  assert.throws(() => new ConversationCoordinator(runtime(PAIR_JOINER_AGENT_ID), runtime(PAIR_CREATOR_AGENT_ID)), /pair roles/);
});

test("production logic centralizes legacy role tokens and contains no couple names", () => {
  const files: string[] = [];
  const collect = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) collect(file);
      else if (/\.(?:ts|tsx|cts|css)$/.test(entry.name)) files.push(file);
    }
  };
  collect(path.resolve("electron"));
  collect(path.resolve("src"));
  for (const file of files) {
    if (file.endsWith(path.join("src", "core", "types.ts"))) continue;
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /["'](?:dima|katya)["']/, `legacy role token escaped its compatibility boundary: ${file}`);
    assert.doesNotMatch(source, /Дмитрий|Дима|Екатерина|Катя/, `couple-specific name in production source: ${file}`);
  }
});
