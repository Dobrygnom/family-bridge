import { randomUUID } from "node:crypto";
import { SupabaseTransport, type RemoteEnvelope } from "../src/core/supabase-transport.js";

const url = "https://knqaygvvqrwmtyqucbsz.supabase.co";
const key = "sb_publishable_igxXq8mdFjW-wKJGSKhtnA_iINygezS";
const secret = randomUUID().replaceAll("-", "");
const a = new SupabaseTransport(url, key, secret);
const invite = await a.createPair();
const b = new SupabaseTransport(url, key, invite.encryptionSecret);
await b.joinPair(invite);
const pair = await a.pairState(invite.pairId);
if (!pair.partner_id) throw new Error("pair did not connect");
const aId = await a.identity();
const recipientId = pair.owner_id === aId ? pair.partner_id : pair.owner_id;
await a.send({ pairId: pair.id, conversationId: randomUUID(), sequence: 1, recipientId, senderAgent: "dima", payload: { text: "smoke" }, idempotencyKey: randomUUID() });
const received = await b.claimNext(pair.id) as RemoteEnvelope<{ text: string }> | null;
if (received?.payload?.text !== "smoke") throw new Error("message did not arrive or decrypt");
await b.acknowledge(received.id);
console.log("Supabase smoke test passed");
