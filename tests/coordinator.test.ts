import assert from "node:assert/strict";
import test from "node:test";
import { ConversationCoordinator } from "../src/core/coordinator.js";
import { MockAgent } from "../src/core/mock-runtime.js";

const base = {
  owner_question: "",
  topics: ["topic"],
  private_report: "",
  shared_summary: "",
};

test("coordinator gives both people room to react before accepting completion", async () => {
  const order: string[] = [];
  const dima = new MockAgent("dima", [
    { ...base, message_to_peer: "a1", status: "continue" },
    { ...base, message_to_peer: "a2", status: "complete" },
  ]);
  const katya = new MockAgent("katya", [
    {
      ...base,
      message_to_peer: "b1",
      status: "complete",
      shared_summary: "done",
    },
  ]);
  const coordinator = new ConversationCoordinator(dima, katya, undefined, {
    maxTurns: 5,
    onEvent(event) {
      if (event.type === "message") order.push(event.from);
    },
  });
  const report = await coordinator.run("topic");
  assert.deepEqual(order, ["dima", "katya", "dima", "katya"]);
  assert.equal(report.status, "completed");
  assert.equal(report.sharedSummary, "done");
});

test("coordinator marks a turn-limit stop as paused rather than a successful result", async () => {
  const continuing = (id: "dima" | "katya") => new MockAgent(id, [{ ...base, message_to_peer: "ещё не закончили", status: "continue" }]);
  const report = await new ConversationCoordinator(continuing("dima"), continuing("katya"), undefined, { maxTurns: 4 }).run("topic");
  assert.equal(report.turns, 4);
  assert.equal(report.status, "paused");
});
