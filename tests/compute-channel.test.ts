import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ComputeChannelManager } from "../electron/compute-channel.js";
import type { AuthStorage, PairingInvite, SupabaseTransport } from "../src/core/supabase-transport.js";
import { generateSharedSecret } from "../src/core/encryption.js";

function network() {
  const pairs = new Map<string, { id: string; owner_id: string; partner_id: string | null; invite: string }>();
  const messages: any[] = [];
  const factory = (secret: string, storage: AuthStorage, preserve: boolean): SupabaseTransport => {
    const identity = async () => {
      let id = await storage.getItem("identity");
      if (!id) { if (preserve) throw new Error("missing identity"); id = randomUUID(); await storage.setItem("identity", id); }
      return id;
    };
    return {
      identity,
      createPair: async () => { const id = randomUUID(), inviteSecret = generateSharedSecret(); pairs.set(id, { id, owner_id: await identity(), partner_id: null, invite: inviteSecret }); return { version: 1, pairId: id, encryptionSecret: secret, inviteSecret }; },
      joinPair: async (invite: PairingInvite) => { const pair = pairs.get(invite.pairId)!; if (pair.invite !== invite.inviteSecret || pair.partner_id) throw new Error("used invite"); pair.partner_id = await identity(); },
      pairState: async (id: string) => { const pair = pairs.get(id), me = await identity(); if (!pair || pair.owner_id !== me && pair.partner_id !== me) throw new Error("no access"); return pair; },
      send: async (input: any) => { let row = messages.find(item => item.key === input.idempotencyKey); if (!row) { row = { id: randomUUID(), key: input.idempotencyKey, pair_id: input.pairId, conversation_id: input.conversationId, sequence_number: input.sequence, sender_id: await identity(), recipient_id: input.recipientId, sender_agent: input.senderAgent, payload: input.payload, status: "pending", created_at: new Date().toISOString() }; messages.push(row); } return row.id; },
      claimNext: async (pairId: string) => { const me = await identity(); const row = messages.find(item => item.pair_id === pairId && item.recipient_id === me && item.status === "pending"); if (row) row.status = "claimed"; return row ?? null; },
      readClaimedReceived: async (pairId: string) => { const me = await identity(); return messages.find(item => item.pair_id === pairId && item.recipient_id === me && item.status === "claimed") ?? null; },
      readConversation: async (pairId: string, conversationId: string) => messages.filter(item => item.pair_id === pairId && item.conversation_id === conversationId),
      acknowledge: async (id: string) => { const row = messages.find(item => item.id === id); if (row) row.status = "processed"; },
      subscribe: () => async () => undefined,
      dispose: () => {},
    } as any;
  };
  return { factory, messages };
}

test("encrypted compute invitations can be switched off and queued work completes through the host", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fb-compute-"));
  const net = network();
  const answer = { message_to_peer: "Готово", status: "continue" as const, owner_question: "", topics: [], private_report: "", shared_summary: "" };
  const host = new ComputeChannelManager(path.join(directory, "host"), directory, net.factory, false, async (request: any) => request.operation === "structured"
    ? { value: { title: "Тема", context: "Контекст", message: "Сообщение" } }
    : { response: answer, sessionId: "thread-1" });
  const client = new ComputeChannelManager(path.join(directory, "client"), directory, net.factory, false);
  try {
    await host.configureHost("Дмитрий");
    const invitation = await host.createInvitation("Дмитрий");
    await client.join(invitation.code);
    assert.equal((await host.state()).channels[0].connected, true);
    assert.equal((await client.state()).mode, "client");
    const agent = client.createAgent("conversation-1", { id: "dima", displayName: "Анна", ownerName: "Анна", peerName: "Борис", perspective: "Только переданный текст", language: "ru" });
    const pending = agent.start("Начни разговор");
    for (let attempt = 0; attempt < 50 && !net.messages.some(item => item.key.endsWith(":request")); attempt += 1) await new Promise(resolve => setTimeout(resolve, 10));
    await (host as any).tick();
    await (client as any).tick();
    assert.deepEqual(await pending, answer);
    assert.equal(net.messages.filter(item => item.key.endsWith(":request")).length, 1);
    assert.equal(net.messages.filter(item => item.key.endsWith(":response")).length, 1);
    const structured = client.executeStructured("structured-job", "new-topic", "Подготовь тему");
    for (let attempt = 0; attempt < 50 && net.messages.filter(item => item.key.endsWith(":request")).length < 2; attempt += 1) await new Promise(resolve => setTimeout(resolve, 10));
    await (host as any).tick(); await (client as any).tick();
    assert.deepEqual(await structured, { title: "Тема", context: "Контекст", message: "Сообщение" });
    await client.disable();
    assert.equal(client.isClient(), false);
    await assert.rejects(agent.respond("Ещё"), /не настроен/);
  } finally { host.dispose(); client.dispose(); await rm(directory, { recursive: true, force: true }); }
});
