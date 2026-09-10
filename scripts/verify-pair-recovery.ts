// Isolated accounts and synthetic messages only; never reads installed profiles.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SupabaseTransport, type AuthStorage } from "../src/core/supabase-transport.js";
import { RecoveryTransport } from "../src/core/recovery-transport.js";
import { openPairRecovery, sealPairRecovery, type PairRecovery } from "../src/core/pair-recovery.js";
import { generateSharedSecret } from "../src/core/encryption.js";
const url = "https://knqaygvvqrwmtyqucbsz.supabase.co";
const key = "sb_publishable_igxXq8mdFjW-wKJGSKhtnA_iINygezS";
const memory = (): AuthStorage => { const values = new Map<string, string>(); return {
  getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); },
}; };
const transports: SupabaseTransport[] = [];
try {
  const ownerStorage = memory(), secret = generateSharedSecret();
  const owner = new SupabaseTransport(url, key, secret, ownerStorage); transports.push(owner);
  const old = await owner.createPair();
  const lostPeer = new SupabaseTransport(url, key, secret, memory()); transports.push(lostPeer);
  await lostPeer.joinPair(old);
  const ownerId = await owner.identity(), lostId = await lostPeer.identity();
  const conversation = randomUUID(), idempotencyKey = `${conversation}:1`;
  const originalId = await owner.send({ pairId: old.pairId, conversationId: conversation, sequence: 1,
    recipientId: lostId, senderAgent: "katya", payload: { kind: "dialogue", topic: "synthetic recovery check", text: "before recovery" }, idempotencyKey });
  const otherConversation = randomUUID();
  const claimedOldId = await lostPeer.send({ pairId: old.pairId, conversationId: otherConversation, sequence: 1,
    recipientId: ownerId, senderAgent: "dima", payload: { text: "old claimed delivery" }, idempotencyKey: `${otherConversation}:1` });
  assert.equal((await owner.claimNext(old.pairId))?.id, claimedOldId); // Simulate a crash before durable receipt/ack.
  const replacement = await owner.createPair();
  const route: PairRecovery = { version: 1, logicalPairId: old.pairId, transportPairId: replacement.pairId,
    creatorAuthId: ownerId, creatorAgent: "katya", inviteSecret: replacement.inviteSecret };
  const opened = openPairRecovery([sealPairRecovery(route, secret)], secret, old.pairId)!;
  owner.dispose(); lostPeer.dispose();
  const a = new RecoveryTransport(url, key, secret, ownerStorage, opened, "katya"); transports.push(a);
  assert.equal((await a.pairState(old.pairId)).partner_id, null);
  const guestStorage = memory(); // All previous guest account credentials deliberately absent.
  const b = new RecoveryTransport(url, key, secret, guestStorage, opened, "dima"); transports.push(b);
  const paired = await b.pairState(old.pairId);
  assert.notEqual(await b.identity(), lostId); assert.equal(paired.id, old.pairId);
  await a.pairState(old.pairId); // Rescues the undelivered envelope without renumbering local history.
  const received = await b.claimNext(old.pairId);
  assert.equal(received?.id, originalId); assert.equal(received?.conversation_id, conversation);
  assert.equal((received?.payload as any).text, "before recovery");
  await b.acknowledge(received!.id);
  await b.send({ pairId: old.pairId, conversationId: conversation, sequence: 2, recipientId: ownerId,
    senderAgent: "dima", payload: { text: "after recovery" }, idempotencyKey: `${conversation}:2` });
  const reply = await a.claimNext(old.pairId);
  assert.equal((reply?.payload as any).text, "after recovery"); assert.equal(reply?.conversation_id, conversation);
  await a.acknowledge(reply!.id);
  const rescued = await a.claimNext(old.pairId);
  assert.equal(rescued?.id, claimedOldId); assert.equal((rescued?.payload as any).text, "old claimed delivery");
  await a.acknowledge(rescued!.id);
  assert.deepEqual((await a.readConversation(old.pairId, conversation)).map(x => x.sequence_number), [1, 2]);
  assert.deepEqual((await b.readConversation(old.pairId, conversation)).map(x => x.sequence_number), [1, 2]);
  a.dispose(); b.dispose();
  const restarted = new RecoveryTransport(url, key, secret, ownerStorage, opened, "katya"); transports.push(restarted);
  const guestRestarted = new RecoveryTransport(url, key, secret, guestStorage, opened, "dima"); transports.push(guestRestarted);
  await restarted.pairState(old.pairId); await guestRestarted.pairState(old.pairId);
  assert.equal(await guestRestarted.claimNext(old.pairId), null, "Restart must not replay a processed message");
  console.log("PASS: lost identity, automatic join, pending delivery, old claimed delivery rescue, bidirectional reply, stable history, restart deduplication.");
} finally { for (const transport of transports) transport.dispose(); }
