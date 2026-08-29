import assert from "node:assert/strict";
import test from "node:test";
import { ConversationCoordinator } from "../src/core/coordinator.js";
import { MockAgent } from "../src/core/mock-runtime.js";

const base = {
  topics: ["topic"],
  private_report: "",
  shared_summary: "",
};

test("coordinator alternates agents and finishes on completion", async () => {
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
  assert.deepEqual(order, ["dima", "katya", "dima"]);
  assert.equal(report.status, "completed");
  assert.equal(report.sharedSummary, "done");
});
