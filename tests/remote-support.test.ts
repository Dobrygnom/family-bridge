import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { RemoteSupport, type SupportContext } from "../electron/remote-support.js";
import { sanitizeSupportReport, supportEvents, supportErrorCode, type SupportReport } from "../electron/support-report.js";
import { Diagnostics } from "../electron/diagnostics.js";
import { startSupportControl, supportLocatorFiles } from "../electron/support-control.js";
import { BackgroundService } from "../electron/background-service.js";
import { AtomicStore } from "../electron/store.js";
import { SupabaseTransport } from "../src/core/supabase-transport.js";
import { RecoveryTransport } from "../src/core/recovery-transport.js";

const now = Date.now();
const report = (at = now): SupportReport => ({ schema: 1, at: new Date(at).toISOString(), bootId: randomUUID(),
  status: { version: "1.2.20", configured: true }, update: { downloading: false, ready: true, waitingFor: "editing" }, events: [] });
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fb-support-"));
  const incoming: any[] = [], sent: any[] = [];
  let updates = 0, clock = now;
  const context: SupportContext = { pairId: "pair", me: "me", peer: "peer", owner: "dima", peerVersion: "1.2.20", transport: {
    readSupportMessages: async () => incoming,
    send: async (value: any) => { sent.push(value); return "sent"; },
  } as any };
  const hooks = { context: async () => context, snapshot: async () => report(clock), update: () => { updates++; }, record: () => {} };
  const support = new RemoteSupport(dir, hooks, () => clock);
  const envelope = (action: string = "snapshot", extra: any = {}) => {
    const id = randomUUID();
    return { id, pair_id: "pair", sender_id: "peer", recipient_id: "me", created_at: new Date(clock).toISOString(),
      payload: { support: { protocol: 1, type: "request", id, sentAt: new Date(clock).toISOString(), action, ...extra } } };
  };
  return { dir, incoming, sent, context, hooks, support, envelope, updates: () => updates, advance: (ms: number) => { clock += ms; },
    cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("support exports only typed technical fields, including logs from the independent fallback", async () => {
  const f = await fixture();
  try {
    const d = new Diagnostics(f.dir, path.join(f.dir, "fallback"));
    d.record("updater.state", { version: "1.2.20", waitingFor: "editing", filePath: "C:/private/name", topicId: "private-topic", code: "SECRET", prompt: "private-text" } as any);
    d.record("private-event-name", { version: "1.2.20" });
    d.record("analysis.progress", { current: 2, total: 4, stage: "private-chat" });
    await rm(d.file);
    const safe = sanitizeSupportReport({ ...report(), status: { version: "private-chat", token: "secret", topics: NaN, onboarding: true },
      events: [...supportEvents(d), { at: new Date(now).toISOString(), event: "analysis.progress", fields: { total: Infinity, stage: "private-chat" } }] });
    assert.ok(safe);
    const json = JSON.stringify(safe);
    assert.doesNotMatch(json, /private|secret|SECRET|Infinity|NaN|filePath|topicId/);
    assert.match(json, /editing/);
    assert.equal(safe.events.find(e => e.event === "analysis.progress")?.fields.current, 2);
    assert.equal(supportErrorCode({ code: "PGRST301", message: "private-text" }), "PGRST301");
    assert.equal(supportErrorCode(new Error("Не удалось восстановить авторизацию подключения")), "AUTH");
    const id = randomUUID(), parentId = randomUUID();
    const detail = sanitizeSupportReport({ ...report(), continuations: [{ id, parentId, status: "error", mode: "restart", attempts: 3, prepared: false, completed: false, active: false, messages: 0, failureKind: "connection", failureCode: "AUTH", topic: "private", instruction: "secret", preparedMessage: "secret", history: ["secret"] }, { id: "private", parentId }, { id, parentId, failureKind: "private", failureCode: "secret", messages: Infinity }] })!;
    assert.doesNotMatch(JSON.stringify(detail), /private|secret|Infinity|history|preparedMessage/);
    assert.equal(detail.continuations?.length, 2);
    assert.equal(detail.continuations?.[0].id, id);
    assert.equal(detail.continuations?.[0].failureCode, "AUTH");
    assert.equal(detail.continuations?.[0].attempts, 3);
  } finally { await f.cleanup(); }
});

test("expired, replayed, wrong-pair, wrong-sender and unknown commands cannot schedule an update", async () => {
  const f = await fixture();
  try {
    f.incoming.push(f.envelope("shell"), f.envelope("update", { sentAt: new Date(now - 600_000).toISOString() }),
      { ...f.envelope("update"), sender_id: "attacker" }, { ...f.envelope("update"), pair_id: "old-pair" },
      { ...f.envelope("update"), historicalDelivery: true }, { ...f.envelope("update"), recipient_id: "other" });
    await f.support.tick();
    assert.equal(f.updates(), 0);
    assert.equal(f.sent.filter(s => s.payload.support.replyTo).length, 0);
    f.incoming.push(f.envelope("update"));
    await f.support.tick(); await f.support.tick();
    assert.equal(f.updates(), 1);
    assert.equal(f.sent.filter(s => s.payload.support.replyTo).length, 1);
    const restarted = new RemoteSupport(f.dir, f.hooks, () => now);
    await restarted.tick();
    assert.equal(f.updates(), 1, "receipt persists across restart");
    assert.equal(f.sent.filter(s => s.payload.support.replyTo).at(-1).payload.support.outcome, "accepted");
  } finally { await f.cleanup(); }
});

test("lost response retries the same receipt without repeating the update", async () => {
  const f = await fixture();
  try {
    f.incoming.push(f.envelope("update"));
    const send = f.context.transport.send;
    let fail = true;
    f.context.transport.send = async value => {
      if ((value.payload as any).support.replyTo && fail) { fail = false; throw new Error("network private details"); }
      return send(value);
    };
    await f.support.tick();
    assert.equal(f.updates(), 1);
    assert.equal((await f.support.status()).transportError, "NETWORK");
    await f.support.tick();
    assert.equal(f.updates(), 1);
    assert.equal(f.sent.filter(s => s.payload.support.replyTo).length, 1);
  } finally { await f.cleanup(); }
});

test("request IDs correlate reports; freshness uses capture time, and delayed requests time out", async () => {
  const f = await fixture();
  try {
    const requested = await f.support.request("snapshot");
    assert.equal(requested.status, "sent");
    assert.equal((await f.support.request("snapshot")).id, requested.id);
    f.incoming.push(f.envelope("snapshot", { type: "report", report: report(), replyTo: requested.id, outcome: "accepted" }));
    await f.support.tick();
    assert.equal((await f.support.status()).requests[0].status, "received");
    f.advance(100_000);
    assert.equal((await f.support.status()).peer?.stale, true);
    assert.equal((await f.support.status()).peer?.ageSeconds, 100);
    await f.support.request("update");
    f.advance(400_000);
    assert.equal((await f.support.status()).requests.at(-1)?.status, "timeout");
    f.context.pairId = "new-pair";
    await f.support.tick();
    assert.equal((await f.support.status()).peer, null, "previous pair report must not appear as the new peer");
  } finally { await f.cleanup(); }
});

test("older peers receive only their existing update command, with no diagnostic success claim", async () => {
  const f = await fixture();
  try {
    f.context.peerVersion = "1.2.12";
    assert.equal((await f.support.request("snapshot")).status, "unsupported");
    assert.equal(f.sent.length, 0);
    assert.equal((await f.support.request("update")).status, "legacy-update-requested");
    assert.equal(f.sent[0].payload.requestUpdateCheck, true);
    assert.equal(f.sent[0].payload.support, undefined);
    assert.equal(f.sent[0].payload.versionOnly, true);
  } finally { await f.cleanup(); }
});

test("local control requires its secret, rejects browser origins and exposes only fixed commands", async () => {
  const f = await fixture();
  const server = await startSupportControl(f.dir, f.support);
  try {
    const locator = JSON.parse(await readFile(supportLocatorFiles(f.dir)[0], "utf8"));
    const url = `http://127.0.0.1:${locator.port}`;
    assert.equal((await fetch(`${url}/status`)).status, 403);
    const headers = { Authorization: `Bearer ${locator.token}` };
    assert.equal((await fetch(`${url}/status`, { headers: { ...headers, Origin: "https://evil.test" } })).status, 403);
    assert.equal((await fetch(`${url}/shell`, { headers, method: "POST" })).status, 404);
    const status = await (await fetch(`${url}/status`, { headers })).json();
    assert.equal(status.local.schema, 1);
    assert.doesNotMatch(JSON.stringify(status), /token|secret|encryption/);
    const requested = await (await fetch(`${url}/peer/snapshot`, { method: "POST", headers })).json();
    assert.equal(requested.status, "sent");
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(supportLocatorFiles(f.dir)[1], { force: true }); await f.cleanup();
  }
});

test("local blocker diagnostics remain readable when normal state reporting is stuck",async()=>{
  const f=await fixture(); let installs=0;
  f.support.status=()=>new Promise(()=>{});
  const server=await startSupportControl(f.dir,f.support,{diagnostics:()=>({schema:1,bootId:'boot',blockers:['state_writes']}),update:()=>{installs++;return {accepted:true};}});
  try {
    const locator=JSON.parse(await readFile(supportLocatorFiles(f.dir)[0],'utf8'));
    const url=`http://127.0.0.1:${locator.port}`, headers={Authorization:`Bearer ${locator.token}`};
    const result=await (await fetch(`${url}/local/diagnostics`,{headers,signal:AbortSignal.timeout(1000)})).json();
    assert.deepEqual(result.blockers,['state_writes']);
    assert.equal((await fetch(`${url}/local/update`,{method:'POST',headers:{...headers,Origin:'https://evil.test'}})).status,403);
    assert.equal(installs,0);
    assert.equal((await fetch(`${url}/local/update`,{method:'POST',headers})).status,200);
    assert.equal(installs,1);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(supportLocatorFiles(f.dir)[1],{force:true});await f.cleanup();}
});

test("support runs during a blocked dialogue pump without an LLM, and preserves private state", async () => {
  const f = await fixture();
  try {
    const store = new AtomicStore(f.dir);
    await store.update({ remote: { pairId: "pair", encryptionSecret: "secret", peerVersion: "1.2.20" },
      displayName: "Private name", pendingTopics: ["private topic"], identityConfigured: false });
    const id = randomUUID(), parentId = randomUUID(), otherId = randomUUID();
    const completedFile = path.join(f.dir, "completed.json");
    await writeFile(completedFile, JSON.stringify({ conversationId: id, topic: "private topic", completedAt: new Date().toISOString(), messages: [] }));
    const job = { parentReportId: parentId, pairId: "pair", topic: "private topic", instruction: "private instruction", history: [], status: "error" as const, mode: "restart" as const, attempts: 3 };
    await store.update({ reports: [completedFile], continuations: { [id]: job, [otherId]: { ...job, pairId: "old-pair" } } });
    const service = new BackgroundService(f.dir, process.cwd(), store, () => null, undefined, { backgroundTasks: false, appVersion: "1.2.20" });
    (service as any).remoteBusy = true;
    (service as any).localRemoteAgent = () => assert.fail("support must not invoke LLM");
    (service as any).remote = { ...f.context.transport, pairState: async () => ({ id: "pair", owner_id: "me", partner_id: "peer" }), identity: async () => "me" };
    assert.equal(await service.prepareForUpdate(),false);
    const before = await readFile(path.join(f.dir, "state.json"), "utf8");
    f.incoming.push(f.envelope());
    await service.support.tick();
    assert.ok(f.sent.some(s => s.payload.support.replyTo));
    const snapshot = (await (service as any).supportSnapshot(false)) as SupportReport;
    assert.equal(snapshot.status.continuations, 0, "Persisted report completes a stale error status");
    assert.equal(snapshot.updateDiagnostics?.quiescing,true);
    assert.ok(snapshot.updateDiagnostics?.blockers.some(b=>b.operation==='remote_poll'));
    assert.equal(snapshot.continuations?.length, 1, "Old-pair attempts are excluded");
    assert.equal(snapshot.continuations?.[0].id, id);
    assert.equal(snapshot.continuations?.[0].completed, true);
    assert.doesNotMatch(JSON.stringify(f.sent), /private topic|private instruction|Private name|encryptionSecret|"secret"/);
    assert.equal(await readFile(path.join(f.dir, "state.json"), "utf8"), before);
  } finally { await f.cleanup(); }
});

test("the recovery route reads support from the active transport pair and restores logical addressing", async () => {
  const original = SupabaseTransport.prototype.readSupportMessages;
  const logicalPairId = randomUUID(), transportPairId = randomUUID();
  const route = { version: 1 as const, logicalPairId, transportPairId, creatorAgent: "dima" as const, creatorAuthId: randomUUID(), inviteSecret: "x".repeat(32) };
  const { recoveryConversationId } = await import("../src/core/pair-recovery.js");
  const id = randomUUID();
  SupabaseTransport.prototype.readSupportMessages = async pairId => {
    assert.equal(pairId, transportPairId);
    return [{ pair_id: transportPairId, conversation_id: recoveryConversationId(route, id), payload: { transport: "recovery-v1", conversationId: id, payload: { support: { id } } } } as any];
  };
  const transport = new RecoveryTransport("https://example.supabase.co", "public-test", "secret", undefined, route, "dima");
  try {
    const rows = await transport.readSupportMessages(logicalPairId, new Date(now).toISOString());
    assert.equal(rows[0].pair_id, logicalPairId);
    assert.equal((rows[0].payload as any).support.id, id);
  } finally { transport.dispose(); SupabaseTransport.prototype.readSupportMessages = original; }
});
