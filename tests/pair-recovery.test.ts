import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { recoveryConversationId, supportsRotatedRecovery, validatePairRecovery, type PairRecovery } from "../src/core/pair-recovery.js";
import { RecoveryTransport } from "../src/core/recovery-transport.js";
import { decryptPayload, encryptPayload } from "../src/core/encryption.js";

const route: PairRecovery = { version: 1, logicalPairId: randomUUID(), transportPairId: randomUUID(),
  creatorAuthId: randomUUID(), creatorAgent: "katya", inviteSecret: "a".repeat(43) };
test("recovery route is strictly bound to one logical and one physical pair", () => {
  assert.deepEqual(validatePairRecovery(route), route);
  assert.throws(() => validatePairRecovery({ ...route, logicalPairId: route.transportPairId }));
  assert.throws(() => validatePairRecovery({ ...route, inviteSecret: "short" }));
  const rotated:PairRecovery={...route,version:2,previousTransportPairId:randomUUID()};
  assert.deepEqual(validatePairRecovery(rotated),rotated);
  assert.throws(()=>validatePairRecovery({...rotated,previousTransportPairId:rotated.transportPairId}));
  assert.throws(()=>validatePairRecovery({...route,previousTransportPairId:randomUUID()}));
});
test("recovered wire conversation ids are deterministic, distinct from old ids, and distinct across pairs", () => {
  const id = randomUUID(), wire = recoveryConversationId(route, id);
  assert.equal(wire, recoveryConversationId(route, id)); assert.notEqual(id, wire);
  assert.notEqual(wire, recoveryConversationId({ ...route, transportPairId: randomUUID() }, id));
});
test("rotated recovery is enabled only after both peers understand the version 2 capsule",()=>{
  assert.equal(supportsRotatedRecovery("2.1.3"),false);
  assert.equal(supportsRotatedRecovery("2.1.4"),true);
  assert.equal(supportsRotatedRecovery("2.2.0"),true);
  assert.equal(supportsRotatedRecovery("1.2.99"),false);
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
test("a rotated recovery route migrates the sender's pending dialogue without nesting its old wrapper", async () => {
  const previousTransportPairId=randomUUID(),logicalConversationId=randomUUID(),originalEnvelopeId=randomUUID(),me=randomUUID();
  const rotated:PairRecovery={...route,version:2,previousTransportPairId};
  const transport=new RecoveryTransport("https://example.test","test","secret",undefined,rotated,"dima");
  let inserted:any;
  const pending={id:randomUUID(),pair_id:previousTransportPairId,conversation_id:randomUUID(),sequence_number:2,
    sender_id:me,recipient_id:rotated.creatorAuthId,sender_agent:"dima",status:"pending",created_at:new Date().toISOString(),idempotency_key:"old-send",
    encrypted_payload:encryptPayload({transport:"recovery-v1",conversationId:logicalConversationId,originalEnvelopeId,payload:{kind:"dialogue",topic:"Тема",text:"Сохранённый ответ"}},"secret")};
  const auth={getSession:async()=>({data:{session:{user:{id:me}}},error:null}),getUser:async()=>({data:{user:{id:me}},error:null}),
    refreshSession:async()=>({error:null}),stopAutoRefresh:async()=>undefined};
  (transport as any).client={auth,rpc:async(name:string)=>name==="get_family_pair"
    ?{data:[{id:rotated.transportPairId,owner_id:rotated.creatorAuthId,partner_id:me}],error:null}:{data:null,error:null},
    from:()=>{const q:any={select:()=>q,eq:()=>q,in:()=>q,order:()=>q,range:async()=>({data:[pending],error:null}),
      insert:(value:any)=>{inserted=value;return{select:()=>({single:async()=>({data:{id:randomUUID()},error:null})})};}};return q;},
    removeAllChannels:async()=>undefined};
  try {
    await transport.pairState(rotated.logicalPairId);
    assert.equal(inserted.pair_id,rotated.transportPairId);
    assert.equal(inserted.recipient_id,rotated.creatorAuthId);
    assert.equal(inserted.conversation_id,recoveryConversationId(rotated,logicalConversationId));
    assert.deepEqual(decryptPayload(inserted.encrypted_payload,"secret"),{transport:"recovery-v1",conversationId:logicalConversationId,
      originalEnvelopeId,payload:{kind:"dialogue",topic:"Тема",text:"Сохранённый ответ"}});
  } finally {transport.dispose();}
});
test("unrelated pair is never silently routed through the recovery channel", async () => {
  const f = fake(); await assert.rejects(f.transport.pairState(randomUUID()), /does not match/);
  assert.equal(f.counts().joins, 0); assert.equal(f.counts().signups, 0);
});
