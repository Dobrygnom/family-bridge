// Isolated server accounts and synthetic metadata; no installed profile access.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SupabaseTransport, type AuthStorage } from "../src/core/supabase-transport.js";
import { generateSharedSecret } from "../src/core/encryption.js";
import { RemoteSupport, type SupportContext } from "../electron/remote-support.js";
import { SupportChannel } from "../electron/support-channel.js";

const root = await mkdtemp(path.join(os.tmpdir(), "fb-support-server-smoke-"));
const url = "https://knqaygvvqrwmtyqucbsz.supabase.co", key = "sb_publishable_igxXq8mdFjW-wKJGSKhtnA_iINygezS";
const transports: SupabaseTransport[] = [], services: RemoteSupport[] = [];
const memory = (): AuthStorage => { const m = new Map<string,string>(); return {
  getItem: k => m.get(k) ?? null, setItem: (k,v) => { m.set(k,v); }, removeItem: k => { m.delete(k); },
}; };
const factory = (secret: string, storage: AuthStorage, preserve = false) => {
  const t = new SupabaseTransport(url, key, secret, storage, preserve); transports.push(t); return t;
};
try {
  const secret = generateSharedSecret(), ta = factory(secret, memory()), tb = factory(secret, memory());
  const invite = await ta.createPair(); await tb.joinPair(invite);
  let primaryBroken = false, blockedPrimaryReads = 0, updates = 0;
  const make = (name: "a" | "b", transport: SupabaseTransport) => {
    const owner = name === "a" ? "dima" : "katya";
    const channel = new SupportChannel(path.join(root, name, "channel"), factory, async () => ({ pairId: invite.pairId, owner }));
    const s = new RemoteSupport(path.join(root, name, "reports"), {
      context: async (): Promise<SupportContext> => {
        if (primaryBroken) { blockedPrimaryReads++; throw new Error("Synthetic primary-session failure"); }
        const pair = await transport.pairState(invite.pairId), me = await transport.identity();
        return { transport, pairId: pair.id, me, peer: pair.owner_id === me ? pair.partner_id! : pair.owner_id, owner, peerVersion: "1.2.20" };
      },
      snapshot: async () => ({ schema: 1, at: new Date().toISOString(), bootId: randomUUID(),
        status: { version: "1.2.20", connected: !primaryBroken }, update: { ready: true, waitingFor: "editing" }, events: [] }),
      update: () => { updates++; }, record: () => {},
    }, Date.now, channel);
    services.push(s); return s;
  };
  const a = make("a", ta), b = make("b", tb);
  for (let i=0; i<5; i++) {
    await a.tick(); await b.tick();
    if ((await a.status()).independentChannel && (await b.status()).independentChannel) break;
  }
  assert.ok((await a.status()).independentChannel && (await b.status()).independentChannel, "independent channel established");
  console.log("PASS: actual Supabase auth, RLS, encrypted service reads and automatic provisioning.");
  primaryBroken = true;
  const snapshot = await a.request("snapshot"); await b.tick(); await a.tick();
  const received = (await a.status()).requests.find(r => r.id === snapshot.id);
  assert.equal(received?.status, "received"); assert.equal(received.report?.status.connected, false);
  const update = await a.request("update"); await b.tick(); await a.tick();
  assert.equal((await a.status()).requests.find(r => r.id === update.id)?.status, "received");
  assert.equal(updates, 1); assert.equal(blockedPrimaryReads, 0);
  console.log("PASS: fresh diagnostic response and update command survive both primary-session failures.");
  b.stop(); const restarted = make("b", tb); await restarted.tick();
  assert.ok((await restarted.status()).independentChannel);
  assert.equal(updates, 1, "persisted receipt prevents replay after restart");
  assert.equal(blockedPrimaryReads, 0);
  console.log("PASS: separate credentials and update receipt survive receiver restart.");
} finally {
  for (const service of services) service.stop();
  for (const transport of transports) transport.dispose();
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  await rm(root, { recursive: true, force: true });
}
