import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryTransport } from "../src/core/transport.js";

test("transport claims and acknowledges exactly one queued message", () => {
  const transport = new InMemoryTransport();
  const sent = transport.push("c1", "dima", "katya", "hello");
  const claimed = transport.claim("c1", "katya");
  assert.equal(claimed?.id, sent.id);
  assert.equal(transport.claim("c1", "katya"), undefined);
  transport.acknowledge(sent.id);
  assert.equal(transport.snapshot("c1")[0].status, "processed");
});

test("released messages become available after a failed processing attempt", () => {
  const transport = new InMemoryTransport();
  const sent = transport.push("c1", "dima", "katya", "hello");
  transport.claim("c1", "katya");
  transport.release(sent.id);
  assert.equal(transport.claim("c1", "katya")?.id, sent.id);
});
