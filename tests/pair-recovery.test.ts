import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { recoveryConversationId, validatePairRecovery, type PairRecovery } from "../src/core/pair-recovery.js";
import { RecoveryTransport } from "../src/core/recovery-transport.js";
import { encryptPayload } from "../src/core/encryption.js";

const route: PairRecovery = { version: 1, logicalPairId: randomUUID(), transportPairId: randomUUID(),
  creatorAuthId: randomUUID(), creatorAgent: "katya", inviteSecret: "a".repeat(43) };
test("recovery route is strictly bound to one logical and one physical pair", () => {
  assert.deepEqual(validatePairRecovery(route), route);
  assert.throws(() => validatePairRecovery({ ...route, logicalPairId: route.transportPairId }));
  assert.throws(() => validatePairRecovery({ ...route, inviteSecret: "short" }));
});
test("recovered wire conversation ids are deterministic, distinct from old ids, and distinct across pairs", () => {
  const id = randomUUID(), wire = recoveryConversationId(route, id);
  assert.equal(wire, recoveryConversationId(route, id)); assert.notEqual(id, wire);
  assert.notEqual(wire, recoveryConversationId({ ...route, transportPairId: randomUUID() }, id));
});

function fake(participant: "dima" | "katya" = "dima", id: string | undefined = randomUUID()) {
  const transport = new RecoveryTransport("https://example.test", "test", "secret", undefined, route, participant);
  let joined = false, signups = 0, joins = 0, acknowledged: string | undefined;
  let claim: unknown, denyLegacyClaim = false;
  const auth = {
    getSession: async () => ({ data: { session: id ? { user: { id } } : null }, error: null }),
    getUser: async () => ({ data: { user: id ? { id } : null }, error: id ? null : { name: "AuthSessionMissingError" } }),
    refreshSession: async () => ({ error: null }),
    signInAnonymously: async () => { signups++; id = randomUUID(); return { data: { user: { id } }, error: null }; },
  };
  (transport as any).client = { auth, rpc: async (name: string, args: any) => {
    if (name === "join_family_pair") { joined = true; joins++; return { data: true, error: null }; }
    if (name === "get_family_pair") return { data: joined || id === route.creatorAuthId ? [{ id: route.transportPairId, owner_id: route.creatorAuthId, partner_id: joined ? id : null }] : [], error: null };
    if (name === "claim_next_bridge_message") {
      if (denyLegacyClaim && args.requested_pair_id === route.logicalPairId) return { data: null, error: { code: "42501", message: "not authorized" } };
      return { data: claim ? [claim] : [], error: null };
    }
    if (name === "ack_bridge_message") { acknowledged = args.requested_message_id; return { error: null }; }
  }, from: () => { const q: any = {}; for (const method of ["select", "eq", "in", "order"]) q[method] = () => q;
    q.range = async () => ({ data: [], error: null }); q.limit = async () => ({ data: [], error: null }); return q; } };
  return { transport, auth, setClaim: (value: unknown) => { claim = value; }, denyLegacy: () => { denyLegacyClaim = true; }, counts: () => ({ signups, joins, acknowledged }) };
}
test("wrong old identity automatically joins the replacement channel without changing logical pair", async () => {
  const f = fake();
  const concurrent = await Promise.all(Array.from({length: 5}, () => f.transport.pairState(route.logicalPairId)));
  assert.ok(concurrent.every(pair => pair.id === route.logicalPairId));
  await f.transport.pairState(route.logicalPairId);
  assert.equal(f.counts().joins, 1); assert.equal(f.counts().signups, 0);
});
test("missing guest identity can recover, but network errors and a lost creator identity cannot create accounts", async () => {
  const guest = fake(); (guest.auth as any).getSession = async () => ({ data: { session: null }, error: null });
  (guest.auth as any).getUser = async () => ({ data: { user: null }, error: { name: "AuthSessionMissingError" } });
  await guest.transport.identity(); assert.equal(guest.counts().signups, 1);
  (guest.auth as any).getUser = async () => ({ data: { user: null }, error: { name: "AuthRetryableFetchError" } });
  await assert.rejects(guest.transport.identity()); assert.equal(guest.counts().signups, 1);
  const owner = fake("katya"); await assert.rejects(owner.transport.identity(), /участник/);
  assert.equal(owner.counts().joins, 0); assert.equal(owner.counts().signups, 0);
});
test("replayed envelope keeps its original inbox id and acknowledges the physical replacement row", async () => {
  const f = fake(), conversation = randomUUID(), original = randomUUID(), physical = randomUUID();
  f.setClaim({ id: physical, pair_id: route.transportPairId, conversation_id: recoveryConversationId(route, conversation),
    encrypted_payload: encryptPayload({ transport: "recovery-v1", conversationId: conversation, originalEnvelopeId: original, payload: { text: "test" } }, "secret") });
  const row = await f.transport.claimNext(route.logicalPairId);
  assert.equal(row?.id, original); assert.equal(row?.conversation_id, conversation); assert.equal(row?.pair_id, route.logicalPairId);
  assert.deepEqual(row?.payload, { text: "test" });
  assert.equal(row?.historicalDelivery, true);
  await f.transport.acknowledge(row!.id); assert.equal(f.counts().acknowledged, physical);
});
test("an invited replacement identity stays connected when the inaccessible old queue is empty", async () => {
  const f = fake();
  await f.transport.pairState(route.logicalPairId);
  f.denyLegacy();
  assert.equal(await f.transport.claimNext(route.logicalPairId), null);
});
test("unrelated pair is never silently routed through the recovery channel", async () => {
  const f = fake(); await assert.rejects(f.transport.pairState(randomUUID()), /does not match/);
  assert.equal(f.counts().joins, 0); assert.equal(f.counts().signups, 0);
});
