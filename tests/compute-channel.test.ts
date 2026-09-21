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
  let provider: { id: string; publicKey: string; enabled: boolean } | undefined;
  const enrollments: any[] = [];
  let enrollmentReadFailures = 0;
  let enrollmentDecisionFailures = 0;
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
      registerDefaultComputeProvider: async (publicKey: string, enabled: boolean) => { provider = { id: await identity(), publicKey, enabled }; },
      requestDefaultComputeProvider: async (publicKey: string) => {
        if (!provider?.enabled) throw new Error("unavailable");
        const me = await identity();
        let request = enrollments.find(item => item.requesterId === me && ["pending", "approved"].includes(item.status));
        if (!request) { request = { id: randomUUID(), requesterId: me, requesterPublicKey: publicKey, providerPublicKey: provider.publicKey, status: "pending", createdAt: new Date().toISOString() }; enrollments.push(request); }
        return { ...request };
      },
      computeEnrollmentRequest: async (id: string) => { if (enrollmentReadFailures > 0) { enrollmentReadFailures -= 1; throw new Error("offline"); } const me = await identity(); const row = enrollments.find(item => item.id === id && item.requesterId === me); if (!row) throw new Error("missing"); return { ...row }; },
      pendingComputeEnrollmentRequests: async () => { const me = await identity(); return enrollments.filter(item => item.status === "pending" && provider?.id === me).map(item => ({ ...item })); },
      decideComputeEnrollmentRequest: async (id: string, approved: boolean, responsePayload?: string) => { if (enrollmentDecisionFailures > 0) { enrollmentDecisionFailures -= 1; throw new Error("lost response"); } const row = enrollments.find(item => item.id === id); if (!row || provider?.id !== await identity()) throw new Error("missing"); row.status = approved ? "approved" : "rejected"; row.responsePayload = responsePayload; row.decidedAt = new Date().toISOString(); },
      subscribeComputeEnrollments: () => async () => undefined,
      send: async (input: any) => { let row = messages.find(item => item.key === input.idempotencyKey); if (!row) { row = { id: randomUUID(), key: input.idempotencyKey, pair_id: input.pairId, conversation_id: input.conversationId, sequence_number: input.sequence, sender_id: await identity(), recipient_id: input.recipientId, sender_agent: input.senderAgent, payload: input.payload, status: "pending", created_at: new Date().toISOString() }; messages.push(row); } return row.id; },
      claimNext: async (pairId: string) => { const me = await identity(); const row = messages.find(item => item.pair_id === pairId && item.recipient_id === me && item.status === "pending"); if (row) row.status = "claimed"; return row ?? null; },
      readClaimedReceived: async (pairId: string) => { const me = await identity(); return messages.find(item => item.pair_id === pairId && item.recipient_id === me && item.status === "claimed") ?? null; },
      readConversation: async (pairId: string, conversationId: string) => messages.filter(item => item.pair_id === pairId && item.conversation_id === conversationId),
      acknowledge: async (id: string) => { const row = messages.find(item => item.id === id); if (row) row.status = "processed"; },
      subscribe: () => async () => undefined,
      dispose: () => {},
    } as any;
  };
  return {
    factory,
    messages,
    enrollments,
    failNextEnrollmentRead: () => { enrollmentReadFailures += 1; },
    failNextEnrollmentDecision: () => { enrollmentDecisionFailures += 1; },
  };
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

test("a trusted computer auto-accepts a durable encrypted enrollment without invitation codes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fb-compute-enrollment-"));
  const net = network();
  const host = new ComputeChannelManager(path.join(directory, "host"), directory, net.factory, false, async () => ({ value: { message: "Следующий вопрос", ready: false }, sessionId: "intake-session" }));
  const client = new ComputeChannelManager(path.join(directory, "client"), directory, net.factory, false);
  try {
    await host.configureHost(undefined, "auto_accept");
    await host.state();
    await client.requestTrustedComputer();
    assert.equal(client.snapshot().enrollmentStatus, "pending");
    await host.state();
    assert.equal(net.enrollments[0].status, "approved");
    assert.equal(typeof net.enrollments[0].responsePayload, "string");
    assert.doesNotMatch(net.enrollments[0].responsePayload, /inviteSecret|encryptionSecret/);
    await client.state();
    await host.state();
    assert.equal(client.isClient(), true);
    assert.equal(client.snapshot().connected, true);
    assert.equal(host.snapshot().channels.length, 1);
    assert.equal(host.snapshot().channels[0].connected, true);
  } finally { host.dispose(); client.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("offline enrollment stays retryable and a lost approval response reuses one enabled channel", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fb-compute-recovery-"));
  const net = network();
  const host = new ComputeChannelManager(path.join(directory, "host"), directory, net.factory, false);
  const client = new ComputeChannelManager(path.join(directory, "client"), directory, net.factory, false);
  try {
    await host.configureHost(undefined, "auto_accept");
    await host.state();
    await client.requestTrustedComputer();

    net.failNextEnrollmentRead();
    assert.equal((await client.state()).enrollmentStatus, "unavailable");
    assert.equal((await client.state()).enrollmentStatus, "pending");

    net.failNextEnrollmentDecision();
    await host.state();
    assert.equal(host.snapshot().channels.length, 1);
    assert.equal(host.snapshot().channels[0].enabled, true);
    assert.equal(net.enrollments[0].status, "pending");

    await host.state();
    assert.equal(host.snapshot().channels.length, 1);
    assert.equal(host.snapshot().channels[0].enabled, true);
    assert.equal(net.enrollments[0].status, "approved");

    await client.state();
    await host.state();
    assert.equal(client.snapshot().connected, true);
    assert.equal(host.snapshot().channels[0].connected, true);
  } finally { host.dispose(); client.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("manual enrollment notifies once, rejects without a channel, and accepts a new request", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fb-compute-manual-"));
  const net = network();
  const notifications: string[] = [];
  const host = new ComputeChannelManager(path.join(directory, "host"), directory, net.factory, false, undefined,
    event => notifications.push(event.requestId));
  const client = new ComputeChannelManager(path.join(directory, "client"), directory, net.factory, false);
  try {
    await host.configureHost(undefined, "ask");
    await host.state();
    await client.requestTrustedComputer();
    const pending = await host.state();
    assert.equal(pending.requests.length, 1);
    assert.deepEqual(notifications, [pending.requests[0].id]);
    await host.state();
    assert.equal(notifications.length, 1);
    await host.decideEnrollment(pending.requests[0].id, false);
    assert.equal((await client.state()).enrollmentStatus, "rejected");
    assert.equal(host.snapshot().channels.length, 0);

    await client.requestTrustedComputer();
    const retry = await host.state();
    assert.equal(retry.requests.length, 1);
    assert.notEqual(retry.requests[0].id, pending.requests[0].id);
    await host.decideEnrollment(retry.requests[0].id, true);
    await client.state();
    assert.equal(client.snapshot().connected, true);
    assert.equal(host.snapshot().channels.length, 1);
  } finally { host.dispose(); client.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("reject policy denies enrollment and disabling the provider blocks new clients", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fb-compute-reject-"));
  const net = network();
  const host = new ComputeChannelManager(path.join(directory, "host"), directory, net.factory, false);
  const client = new ComputeChannelManager(path.join(directory, "client"), directory, net.factory, false);
  try {
    await host.configureHost(undefined, "reject");
    await host.state();
    await client.requestTrustedComputer();
    await host.state();
    assert.equal((await client.state()).enrollmentStatus, "rejected");
    assert.equal(host.snapshot().channels.length, 0);
    await host.disable();
    const another = new ComputeChannelManager(path.join(directory, "another"), directory, net.factory, false);
    try { await assert.rejects(another.requestTrustedComputer(), /unavailable/); }
    finally { another.dispose(); }
  } finally { host.dispose(); client.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("two enrolled clients receive separate channels and only their own results", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fb-compute-two-clients-"));
  const net = network();
  const host = new ComputeChannelManager(path.join(directory, "host"), directory, net.factory, false,
    async request => ({ value: { message: `Ответ: ${request.prompt}`, ready: false }, sessionId: `session-${request.id}` }));
  const first = new ComputeChannelManager(path.join(directory, "first"), directory, net.factory, false);
  const second = new ComputeChannelManager(path.join(directory, "second"), directory, net.factory, false);
  try {
    await host.configureHost(undefined, "auto_accept");
    await host.state();
    await first.requestTrustedComputer();
    await second.requestTrustedComputer();
    await host.state();
    await first.state();
    await second.state();
    assert.equal(host.snapshot().channels.length, 2);
    assert.notEqual(host.snapshot().channels[0].channelId, host.snapshot().channels[1].channelId);
    assert.equal(first.snapshot().connected, true);
    assert.equal(second.snapshot().connected, true);

    const a = first.executePersistentStructured("same-key", "intake-response", "Первый человек");
    const b = second.executePersistentStructured("same-key", "intake-response", "Второй человек");
    for (let attempt = 0; attempt < 50 && net.messages.filter(item => item.key.endsWith(":request")).length < 2; attempt += 1)
      await new Promise(resolve => setTimeout(resolve, 10));
    await host.state();
    await first.state();
    await second.state();
    assert.deepEqual((await a).value, { message: "Ответ: Первый человек", ready: false });
    assert.deepEqual((await b).value, { message: "Ответ: Второй человек", ready: false });
    assert.equal(new Set(net.messages.filter(item => item.key.endsWith(":request")).map(item => item.pair_id)).size, 2);
  } finally { host.dispose(); first.dispose(); second.dispose(); await rm(directory, { recursive: true, force: true }); }
});
