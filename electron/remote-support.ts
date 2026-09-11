import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SupabaseTransport, RemoteEnvelope } from "../src/core/supabase-transport.js";
import type { OwnerId } from "./store.js";
import { VERSION_PROBE_PREFIX, validPeerVersion } from "../src/core/peer-version.js";
import { replaceStateFile } from "./store.js";
import { sanitizeSupportReport, supportErrorCode, supportId, type SupportReport } from "./support-report.js";
import type { SupportChannel, SupportOffer } from "./support-channel.js";
import type { RuntimeDiagnostics } from "./runtime-diagnostics.js";

export type SupportAction = "snapshot" | "update";
interface SupportWire {
  protocol: 1; type: "request" | "report" | "offer"; id: string; sentAt: string;
  offer?: SupportOffer;
  action?: SupportAction; report?: SupportReport; replyTo?: string;
  outcome?: "accepted" | "failed";
}
export interface SupportContext {
  transport: SupabaseTransport; pairId: string; me: string; peer: string;
  owner: OwnerId; peerVersion?: string;
  independent?: boolean;
}
export function supportsRemoteSupport(version: string | undefined) {
  if (!validPeerVersion(version)) return false;
  const [a,b,c] = version!.split(".").map(Number);
  return a > 1 || a === 1 && (b > 2 || b === 2 && c >= 20);
}
const fresh = (at: unknown, now: number, ttl = 5 * 60_000) => {
  const t = typeof at === "string" ? Date.parse(at) : NaN;
  return Number.isFinite(t) && t <= now + 30_000 && now - t <= ttl;
};

/** A bounded application support protocol. No arbitrary command, path, URL,
 * transcript or credential is accepted. Uses the pair's existing encryption. */
export class RemoteSupport {
  private busy = false;
  private context?: SupportContext;
  private lastHeartbeat = 0;
  private lastOffer = 0;
  private timer?: NodeJS.Timeout;
  private receipts = new Map<string, SupportWire>();
  private loaded = false;
  private loading?: Promise<void>;
  private delivered = new Set<string>();
  private pending = new Map<string, { pairId: string; requestedAt: string; action: SupportAction; status: string; report?: SupportReport }>();
  private latest?: { pairId: string; receivedAt: string; report: SupportReport };
  private lastError?: string;
  private sending = false;
  constructor(private readonly directory: string, private readonly hooks: {
    runtime?: RuntimeDiagnostics;
    context: () => Promise<SupportContext | undefined>;
    snapshot: (logs: boolean) => Promise<SupportReport>;
    update: () => void;
    record: (event: string, code?: string) => void;
  }, private readonly now = Date.now, private readonly channel?: SupportChannel) {}

  start() {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 5_000);
    this.timer.unref();
  }
  stop() { clearInterval(this.timer); this.timer = undefined; this.channel?.dispose(); }

  /** Only authenticated, current peer evidence may affect automatic recovery. */
  peerReport(): SupportReport | undefined {
    return this.latest?.pairId === this.context?.pairId && this.latest && fresh(this.latest.report.at, this.now(), 90_000)
      ? this.latest.report : undefined;
  }

  private async resolveContext() {
    // A broken support credential must not hide a still-working primary path.
    try { const independent = await this.channel?.context(); if (independent) return independent; }
    catch { this.hooks.record("support.channel-failed"); }
    return this.hooks.context();
  }

  private async save(name: string, value: unknown) {
    await mkdir(this.directory, { recursive: true });
    const target = path.join(this.directory, name), temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await replaceStateFile(temporary, target);
  }
  private load(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    return this.loading ??= this.loadSaved().finally(() => { this.loading = undefined; });
  }
  private async loadSaved() {
    try {
      const saved = JSON.parse(await readFile(path.join(this.directory, "receipts.json"), "utf8"));
      for (const [key, value] of Object.entries(saved)) {
        const r = value as SupportWire;
        const report = sanitizeSupportReport(r?.report);
        if (r && supportId(r.id) && supportId(r.replyTo) && r.type === "report" && fresh(r.sentAt, this.now()) && report)
          this.receipts.set(key, { protocol: 1, type: "report", id: r.id, replyTo: r.replyTo, sentAt: r.sentAt, outcome: r.outcome === "accepted" ? "accepted" : "failed", report });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      const old = JSON.parse(await readFile(path.join(this.directory, "peer.json"), "utf8"));
      const report = sanitizeSupportReport(old.report);
      if (report && typeof old.pairId === "string") this.latest = { pairId: old.pairId, receivedAt: old.receivedAt, report };
    } catch { /* A cached peer report is optional. */ }
    try {
      const saved = JSON.parse(await readFile(path.join(this.directory, "requests.json"), "utf8"));
      for (const [id, r] of Object.entries(saved).slice(-30) as Array<[string, any]>) {
        if (!supportId(id) || !r || typeof r.pairId !== "string" || !["snapshot", "update"].includes(r.action)
          || !["sending", "sent", "received", "failed", "legacy-update-requested"].includes(r.status)
          || !fresh(r.requestedAt, this.now(), 24 * 60 * 60_000)) continue;
        this.pending.set(id, { pairId: r.pairId, requestedAt: r.requestedAt, action: r.action,
          status: r.status === "sending" ? "failed" : r.status, report: sanitizeSupportReport(r.report) });
      }
    } catch { /* Old versions have no operator requests. */ }
    this.loaded = true;
  }
  async status() {
    await this.load();
    const local = await this.hooks.snapshot(false);
    const latest = this.latest?.pairId === this.context?.pairId ? this.latest : undefined;
    return { local, independentChannel: this.context?.independent === true, transportError: this.lastError, peer: latest ? { ...latest,
      ageSeconds: Math.max(0, Math.floor((this.now() - Date.parse(latest.report.at)) / 1000)),
      stale: !fresh(latest.report.at, this.now(), 90_000) } : null,
      requests: [...this.pending.entries()].map(([id, request]) => ({ id, ...request,
        status: request.status === "sent" && !fresh(request.requestedAt, this.now()) ? "timeout" : request.status })) };
  }

  async request(action: SupportAction) {
    if (action !== "snapshot" && action !== "update") throw new Error("Unsupported support action");
    if (this.sending) throw new Error("Support request already sending");
    this.sending = true;
    try {
      await this.load();
      const c = await this.resolveContext();
      if (!c) throw new Error("Peer unavailable");
      this.context = c;
      const same = [...this.pending.entries()].find(([,r]) => r.pairId === c.pairId && r.action === action && r.status === "sent" && fresh(r.requestedAt, this.now(), 30_000));
      if (same) return { id: same[0], status: same[1].status };
      const id = randomUUID(), sentAt = new Date(this.now()).toISOString();
      const supported = supportsRemoteSupport(c.peerVersion);
      if (!supported && action === "snapshot") return { status: "unsupported", peerVersion: validPeerVersion(c.peerVersion) };
      this.pending.set(id, { pairId: c.pairId, requestedAt: sentAt, action, status: "sending" });
      while (this.pending.size > 30) this.pending.delete(this.pending.keys().next().value!);
      await this.save("requests.json", Object.fromEntries(this.pending));
      try {
        await this.send(c, { protocol: 1, type: "request", id, sentAt, action }, !supported);
        this.pending.get(id)!.status = supported ? "sent" : "legacy-update-requested";
      } catch (error) { this.pending.get(id)!.status = "failed"; throw error; }
      finally { await this.save("requests.json", Object.fromEntries(this.pending)); }
      this.hooks.record("support.request");
      return { id, status: this.pending.get(id)!.status };
    } finally { this.sending = false; }
  }

  private send(c: SupportContext, support: SupportWire, legacyUpdate = false) {
    return c.transport.send({ pairId: c.pairId, recipientId: c.peer, senderAgent: c.owner,
      conversationId: support.id, sequence: 1, idempotencyKey: `support-v1:${support.id}`,
      payload: { kind: "topic", versionOnly: true, topic: `${VERSION_PROBE_PREFIX}support:${support.id}`,
        requestUpdateCheck: legacyUpdate, support: legacyUpdate ? undefined : support } });
  }

  // Read directly from the service lane, even while the conversation pump is
  // waiting for an LLM. The ordinary pump later acknowledges these envelopes.
  async tick() {
    if (this.busy) return;
    this.busy = true;
    this.hooks.runtime?.begin("support", "store");
    try {
      await this.load();
      await this.save("local.json", await this.hooks.snapshot(false));
      this.hooks.runtime?.stage("support", "context");
      const c = await this.resolveContext();
      if (!c) { this.context = undefined; return; }
      if (this.context?.pairId !== c.pairId || this.context.peer !== c.peer) {
        this.lastHeartbeat = 0;
        if (c.independent) this.hooks.record("support.channel-ready");
      }
      this.context = c;
      this.hooks.runtime?.stage("support", "receive");
      const incoming = await c.transport.readSupportMessages(c.pairId, new Date(this.now() - 5 * 60_000).toISOString());
      this.hooks.runtime?.stage("support", "dispatch");
      for (const envelope of incoming) await this.receive(c, envelope);
      this.hooks.runtime?.stage("support", "send");
      if (!c.independent && supportsRemoteSupport(c.peerVersion) && this.now() - this.lastOffer >= 60_000) {
        const offer = await this.channel?.offer(c);
        if (offer) await this.send(c, { protocol: 1, type: "offer", id: randomUUID(), sentAt: new Date(this.now()).toISOString(), offer });
        this.lastOffer = this.now();
      }
      if (supportsRemoteSupport(c.peerVersion) && this.now() - this.lastHeartbeat >= 60_000) {
        await this.send(c, { protocol: 1, type: "report", id: randomUUID(), sentAt: new Date(this.now()).toISOString(), report: await this.hooks.snapshot(false) });
        this.lastHeartbeat = this.now();
      }
      this.lastError = undefined;
    } catch (error) {
      this.lastError = supportErrorCode(error);
      this.hooks.runtime?.fail("support", this.lastError);
      this.hooks.record("support.failed", this.lastError);
    } finally { this.hooks.runtime?.end("support"); this.busy = false; }
  }

  private async receive(c: SupportContext, envelope: RemoteEnvelope) {
    const r = (envelope.payload as { support?: SupportWire })?.support;
    if (!r || r.protocol !== 1 || !supportId(r.id) || envelope.pair_id !== c.pairId
      || envelope.sender_id !== c.peer || envelope.recipient_id !== c.me
      || envelope.historicalDelivery || !fresh(envelope.created_at, this.now()) || !fresh(r.sentAt, this.now())) return;
    if (r.type === "offer") {
      if (!c.independent) await this.channel?.accept(c, r.offer);
      return;
    }
    if (r.type === "report") {
      const report = sanitizeSupportReport(r.report);
      if (!report || !fresh(report.at, this.now())) return;
      if (!this.latest || this.latest.pairId !== c.pairId || this.latest.report.at < report.at) {
        this.latest = { pairId: c.pairId, receivedAt: new Date(this.now()).toISOString(), report };
        await this.save("peer.json", this.latest);
      }
      const pending = r.replyTo && this.pending.get(r.replyTo);
      if (pending && pending.pairId === c.pairId && fresh(pending.requestedAt, this.now()) && pending.report?.at !== report.at) {
        pending.status = r.outcome === "accepted" ? "received" : "failed";
        pending.report = report;
        await this.save("requests.json", Object.fromEntries(this.pending));
      }
      return;
    }
    if (r.type !== "request" || !["snapshot", "update"].includes(r.action!)) return;
    const key = `${c.pairId}:${c.peer}:${r.id}`;
    if (this.delivered.has(key)) return;
    let reply = this.receipts.get(key);
    if (!reply) {
      this.hooks.record("support.received");
      // Persist acceptance before scheduling an update or sending its receipt.
      reply = { protocol: 1, type: "report", id: randomUUID(), sentAt: new Date(this.now()).toISOString(), replyTo: r.id,
        outcome: "accepted", report: await this.hooks.snapshot(true) };
      this.receipts.set(key, reply);
      for (const [k,v] of this.receipts) if (!fresh(v.sentAt, this.now())) { this.receipts.delete(k); this.delivered.delete(k); }
      if (this.receipts.size > 100) { this.receipts.delete(key); return; }
      try { await this.save("receipts.json", Object.fromEntries(this.receipts)); }
      catch (error) { this.receipts.delete(key); throw error; }
      if (r.action === "update") {
        this.hooks.record("support.update-requested");
        try { this.hooks.update(); } catch { reply.outcome = "failed"; }
      }
    }
    await this.send(c, reply);
    this.delivered.add(key);
  }
}
