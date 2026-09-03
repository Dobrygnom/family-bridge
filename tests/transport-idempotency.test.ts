import assert from "node:assert/strict";
import test from "node:test";
import { SupabaseTransport } from "../src/core/supabase-transport.js";
import { generateSharedSecret } from "../src/core/encryption.js";

test("lost send responses can be retried only when the saved message matches this conversation", async () => {
  const transport = new SupabaseTransport("https://example.test", "test", generateSharedSecret());
  const input = { pairId: "pair", conversationId: "conversation", sequence: 1, recipientId: "peer", senderAgent: "dima" as const, payload: { text: "hello" }, idempotencyKey: "conversation:1" };
  const conflict = { code: "23505" };
  let row = { id: "sent-id", pair_id: "pair", conversation_id: "conversation", sequence_number: 1, sender_id: "owner" };
  (transport as any).ensureAnonymousIdentity = async () => "owner";
  (transport as any).client = { from: () => ({
    insert: () => ({ select: () => ({ single: async () => ({ error: conflict }) }) }),
    select: () => ({ eq: () => ({ single: async () => ({ data: row }) }) }),
  }) };
  assert.equal(await transport.send(input), "sent-id");
  row = { ...row, conversation_id: "different" };
  await assert.rejects(transport.send(input));
});
