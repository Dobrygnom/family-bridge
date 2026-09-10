import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SupportChannel } from "../electron/support-channel.js";
import { RemoteSupport, type SupportContext } from "../electron/remote-support.js";
import type { AuthStorage, PairingInvite, SupabaseTransport } from "../src/core/supabase-transport.js";
import { generateSharedSecret } from "../src/core/encryption.js";

function network() {
  const pairs = new Map<string, { id: string; owner_id: string; partner_id: string | null; invite: string }>();
  const messages: any[] = [];
  const factory = (secret: string, storage: AuthStorage, preserve: boolean): SupabaseTransport => {
    const identity = async () => {
      let id = await storage.getItem("identity");
      if (!id) { if (preserve) throw new Error("Missing support identity"); id = randomUUID(); await storage.setItem("identity", id); }
      return id;
    };
    return { identity, createPair: async () => {
      const id = randomUUID(), inviteSecret = generateSharedSecret();
      pairs.set(id, { id, owner_id: await identity(), partner_id: null, invite: inviteSecret });
      return { version: 1, pairId: id, encryptionSecret: secret, inviteSecret };
    }, pairState: async (id: string) => {
      const p = pairs.get(id), me = await identity();
      if (!p || p.owner_id !== me && p.partner_id !== me) throw new Error("No access");
      return p;
    }, joinPair: async (invite: PairingInvite) => {
      const p = pairs.get(invite.pairId)!;
      if (p.partner_id || p.invite !== invite.inviteSecret) throw new Error("Used invite");
      p.partner_id = await identity();
    }, send: async (v: any) => {
      if (!messages.some(m => m.key === v.idempotencyKey)) messages.push({ key: v.idempotencyKey, pair_id: v.pairId,
        sender_id: await identity(), recipient_id: v.recipientId, payload: v.payload, created_at: new Date().toISOString() });
      return v.idempotencyKey;
    }, readSupportMessages: async (id: string) => {
      const me = await identity(); return messages.filter(m => m.pair_id === id && m.recipient_id === me);
    }, dispose: () => {} } as any;
  };
  return { factory, pairs };
}

test("separate support sessions bootstrap automatically and survive loss of both dialogue sessions and restart", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fb-support-channel-"));
  const net = network(), pairId = randomUUID();
  const channelA = new SupportChannel(path.join(dir, "a"), net.factory, async () => ({ pairId, owner: "dima" }));
  const channelB = new SupportChannel(path.join(dir, "b"), net.factory, async () => ({ pairId, owner: "katya" }));
  const queues: Record<string, any[]> = { a: [], z: [] };
  const primary = (me: string, peer: string): SupportContext => ({ me, peer, pairId, owner: me === "a" ? "dima" : "katya", peerVersion: "1.2.20", transport: {
    readSupportMessages: async () => queues[me], send: async (v: any) => {
      queues[peer].push({ pair_id: pairId, sender_id: me, recipient_id: peer, payload: v.payload, created_at: new Date().toISOString() }); return "sent";
    },
  } as any });
  let primaryBroken = false, updates = 0, readsAfterBreak = 0;
  const hooks = (me: string, peer: string) => ({ context: async () => {
    if (primaryBroken) { readsAfterBreak++; throw new Error("Dialogue auth is broken"); } return primary(me, peer);
  }, snapshot: async () => ({ schema: 1 as const, at: new Date().toISOString(), bootId: randomUUID(), status: { version: "1.2.20", connected: !primaryBroken }, update: {}, events: [] }),
    update: () => { updates++; }, record: () => {} });
  const a = new RemoteSupport(path.join(dir, "reports-a"), hooks("a", "z"), Date.now, channelA);
  const b = new RemoteSupport(path.join(dir, "reports-b"), hooks("z", "a"), Date.now, channelB);
  try {
    await a.tick(); await b.tick(); await a.tick(); await b.tick();
    assert.equal(net.pairs.size, 1, "one separate pair, deterministic creator");
    const ca = await channelA.context(), cb = await channelB.context();
    assert.ok(ca && cb); assert.equal(ca.pairId, cb.pairId); assert.equal(ca.peer, cb.me);
    assert.notEqual(ca.pairId, pairId);
    primaryBroken = true;
    const request = await a.request("update");
    await b.tick(); await a.tick();
    assert.equal(updates, 1);
    assert.equal((await a.status()).independentChannel, true);
    assert.equal((await a.status()).requests.find(r => r.id === request.id)?.status, "received");
    assert.equal((await a.status()).requests.find(r => r.id === request.id)?.report?.status.connected, false);
    assert.equal(readsAfterBreak, 0, "support must not consult failed dialogue credentials");
    const restarted = new SupportChannel(path.join(dir, "b"), net.factory, async () => ({ pairId, owner: "katya" }));
    assert.equal((await restarted.context())?.me, cb.me);
    assert.equal(net.pairs.size, 1);
  } finally { a.stop(); b.stop(); await rm(dir, { recursive: true, force: true }); }
});

test("offers cannot bind another logical pair or replace an established support channel", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fb-support-binding-"));
  const net = network(), pairId = randomUUID();
  let binding = pairId;
  const a = new SupportChannel(path.join(dir, "a"), net.factory, async () => ({ pairId, owner: "dima" }));
  const b = new SupportChannel(path.join(dir, "b"), net.factory, async () => ({ pairId: binding, owner: "katya" }));
  const primary = { me: "a", peer: "z", pairId } as SupportContext, peer = { ...primary, me: "z", peer: "a" };
  try {
    const offer = await a.offer(primary); assert.ok(offer);
    await b.accept(peer, { ...offer, logicalPairId: randomUUID() });
    assert.equal(await b.context(), undefined);
    await b.accept(peer, offer);
    const established = await b.context(); assert.ok(established);
    await b.accept(peer, { ...offer, invite: { ...offer.invite, pairId: randomUUID() } });
    assert.equal((await b.context())?.pairId, established.pairId);
    binding = randomUUID();
    assert.equal(await b.context(), undefined, "unpair/change must detach previous support channel");
  } finally { a.dispose(); b.dispose(); await rm(dir, { recursive: true, force: true }); }
});
