import { copyFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AtomicStore } from "../electron/store.js";
import { durableAuthStorage } from "../electron/auth-storage.js";
import { SupportChannel } from "../electron/support-channel.js";
import { validatePairRecovery } from "../src/core/pair-recovery.js";
import { RecoveryTransport } from "../src/core/recovery-transport.js";
import { SupabaseTransport } from "../src/core/supabase-transport.js";
import { VERSION_PROBE_PREFIX } from "../src/core/peer-version.js";

const url = "https://knqaygvvqrwmtyqucbsz.supabase.co";
const key = "sb_publishable_igxXq8mdFjW-wKJGSKhtnA_iINygezS";
const profile = process.argv[2] || (process.platform === "win32"
  ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "family-bridge")
  : path.join(os.homedir(), "Library", "Application Support", "family-bridge"));
const store = new AtomicStore(profile);
const before = await store.read();
if (!before.remote?.recoveryRoute) throw new Error("No existing recovery route to replace");
const oldRoute = validatePairRecovery(before.remote.recoveryRoute);
const channel = new SupportChannel(path.join(profile, "support-channel"),
  (secret, storage, preserve) => new SupabaseTransport(url, key, secret, storage, preserve),
  async () => {
    const state = await store.read();
    return state.remote ? { pairId:state.remote.pairId, owner:state.owner, peerVersion:state.remote.peerVersion } : undefined;
  });

const support = await channel.context();
if (!support) throw new Error("Independent support channel is unavailable");
const requestId = randomUUID(), sentAt = new Date().toISOString();
await support.transport.send({
  pairId:support.pairId, recipientId:support.peer, senderAgent:support.owner,
  conversationId:requestId, sequence:1, idempotencyKey:`support-v1:${requestId}`,
  payload:{ kind:"topic", versionOnly:true, topic:`${VERSION_PROBE_PREFIX}support:${requestId}`,
    support:{ protocol:1, type:"request", id:requestId, sentAt, action:"recover" } },
});

let reply: any;
const after = new Date(Date.parse(sentAt) - 5_000).toISOString();
for (let attempt = 0; attempt < 60 && !reply; attempt += 1) {
  await delay(2_000);
  const rows = await support.transport.readSupportMessages(support.pairId, after);
  reply = rows.map(row => ({ row, wire:(row.payload as any)?.support }))
    .find(item => item.row.sender_id === support.peer && item.row.recipient_id === support.me
      && item.wire?.protocol === 1 && item.wire?.type === "report" && item.wire?.replyTo === requestId)?.wire;
}
if (!reply) throw new Error("Peer did not answer the forced recovery request");
if (reply.outcome !== "accepted") throw new Error("Peer rejected the forced recovery request");
const newRoute = validatePairRecovery(reply.recovery);
if (newRoute.logicalPairId !== before.remote.pairId || newRoute.creatorAgent === before.owner
  || newRoute.transportPairId === oldRoute.transportPairId) throw new Error("Peer returned an invalid replacement route");

const oldTransport = new RecoveryTransport(url, key, before.remote.encryptionSecret,
  durableAuthStorage(profile), oldRoute, before.owner);
let pending: Awaited<ReturnType<SupabaseTransport["readPendingSent"]>> = [];
try { pending = await oldTransport.readPendingSent(oldRoute.transportPairId); }
finally { oldTransport.dispose(); }

await copyFile(path.join(profile, "state.json"), path.join(profile, `state.before-forced-recovery-${Date.now()}.json`));
await store.mutate(current => current.remote?.pairId === newRoute.logicalPairId
  ? { remote:{ ...current.remote, recoveryRoute:newRoute } } : {});

const replacement = new RecoveryTransport(url, key, before.remote.encryptionSecret,
  durableAuthStorage(profile), newRoute, before.owner);
const migrated: Array<{ oldId:string; newId:string; conversationId:string; sequence:number }> = [];
try {
  const pair = await replacement.pairState(newRoute.logicalPairId);
  const me = await replacement.identity();
  const recipientId = pair.owner_id === me ? pair.partner_id : pair.owner_id;
  if (!recipientId) throw new Error("Replacement pair has no peer");
  for (const row of pending) {
    const wrapper = row.payload as { transport?:unknown; conversationId?:unknown; payload?:any };
    if (wrapper?.transport !== "recovery-v1" || typeof wrapper.conversationId !== "string") continue;
    const payload = wrapper.payload;
    if (!payload || payload.versionOnly || payload.support || String(payload.topic ?? "").startsWith(VERSION_PROBE_PREFIX)) continue;
    const newId = await replacement.send({ pairId:newRoute.logicalPairId, conversationId:wrapper.conversationId,
      sequence:row.sequence_number, recipientId, senderAgent:row.sender_agent, payload,
      idempotencyKey:`forced-recovery:${oldRoute.transportPairId}:${row.id}` });
    migrated.push({ oldId:row.id, newId, conversationId:wrapper.conversationId, sequence:row.sequence_number });
  }
} finally { replacement.dispose(); channel.dispose(); }

console.log(JSON.stringify({ status:"recovered", requestId, oldTransportPairId:oldRoute.transportPairId,
  newTransportPairId:newRoute.transportPairId, pendingFound:pending.length, migrated }, null, 2));
