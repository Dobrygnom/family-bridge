import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { durableAuthStorage } from "./auth-storage.js";
import { replaceStateFile } from "./store.js";
import { generateSharedSecret } from "../src/core/encryption.js";
import { SupabaseTransport, type PairingInvite, type RemoteEnvelope } from "../src/core/supabase-transport.js";
import { CodexCliAgent, defaultCodexCommand, type CodexRuntimeOptions } from "../src/core/codex-runtime.js";
import type { AgentResponse, AgentRuntime } from "../src/core/types.js";
import { isolatedCodexInvocation, codexTaskFailure } from "../src/core/codex-isolation.js";
import { codexReasoningArgs } from "../src/core/codex-model.js";
import {
  createEnrollmentKeyPair,
  openEnrollmentPayload,
  sealEnrollmentPayload,
  validEnrollmentPrivateKey,
  validEnrollmentPublicKey,
  type EnrollmentKeyPair,
} from "./compute-enrollment-crypto.js";
import type { ComputeApprovalPolicy, ComputeEnrollmentRequest } from "../src/core/supabase-transport.js";

const PROTOCOL = 1;
const REQUEST_LIMIT = 120_000;
// Realtime wakes normal work. One metadata-only minute poll is only a fallback
// for sleep, dropped subscriptions and long-offline computers.
const POLL_MS = 60_000;

type ComputeOperation = "start" | "respond" | "owner" | "revise" | "structured" | "persistent-structured";
type ComputeSchema = "new-topic" | "topic-refinement" | "portrait-updates" | "intake-response" | "context-analysis";
interface ComputeRequest {
  protocol: 1;
  type: "request";
  id: string;
  createdAt: string;
  operation: ComputeOperation;
  schema?: ComputeSchema;
  sessionId?: string;
  prompt: string;
  agent?: {
    id: "dima" | "katya";
    displayName: string;
    ownerName?: string;
    peerName?: string;
    perspective: string;
    language?: "ru" | "en" | "cs" | "fr";
    communicationExamples?: string;
  };
}
interface ComputeResponse {
  protocol: 1;
  type: "response";
  requestId: string;
  outcome: "ok" | "error";
  response?: AgentResponse;
  value?: unknown;
  sessionId?: string;
  code?: "COMPUTE_FAILED" | "COMPUTE_INVALID" | "COMPUTE_LIMIT";
}
interface ComputeInvitation { protocol: 1; channelId: string; sponsorName: string; creatorId: string; invite: PairingInvite }
interface HostChannel extends ComputeInvitation { clientLabel: string; enabled: boolean; createdAt: string; enrollmentRequestId?: string }
interface ClientBinding { invitation: ComputeInvitation; joinedAt: string; enabled: boolean }
interface SavedEnrollmentRequest {
  id: string;
  requesterPublicKey: string;
  providerPublicKey: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
}
interface ComputeSettings {
  mode: "off" | "host" | "client";
  sponsorName?: string;
  approvalPolicy?: ComputeApprovalPolicy;
  providerConfigured?: boolean;
  channels: HostChannel[];
  client?: ClientBinding;
  enrollment?: SavedEnrollmentRequest;
}
interface ClientJob { key: string; request: ComputeRequest; sent?: boolean; response?: ComputeResponse; updatedAt: string }
interface SavedHostResult { response?: ComputeResponse; retryAt?: number; recipientId: string; conversationId: string; createdAt: string }

export interface ComputeState {
  mode: "off" | "host" | "client";
  sponsorName?: string;
  connected: boolean;
  pending: number;
  approvalPolicy: ComputeApprovalPolicy;
  enrollmentStatus: "idle" | "pending" | "approved" | "rejected" | "unavailable";
  requests: Array<{ id: string; createdAt: string }>;
  channels: Array<{ channelId: string; label: string; enabled: boolean; connected: boolean; createdAt: string }>;
}

const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const bounded = (value: unknown, maximum: number) => typeof value === "string" && value.length <= maximum;
const optionalBounded = (value: unknown, maximum: number) => value === undefined || bounded(value, maximum);
const validInvitation = (value: unknown): value is ComputeInvitation => {
  const item = value as ComputeInvitation | null;
  return Boolean(item && item.protocol === PROTOCOL && uuid(item.channelId) && bounded(item.sponsorName, 80) && item.sponsorName.trim()
    && uuid(item.creatorId) && item.invite?.version === 1 && uuid(item.invite.pairId)
    && /^[A-Za-z0-9_-]{43}$/.test(item.invite.inviteSecret) && /^[A-Za-z0-9_-]{43}$/.test(item.invite.encryptionSecret));
};
const validRequest = (value: unknown): value is ComputeRequest => {
  const item = value as ComputeRequest | null;
  return Boolean(item && item.protocol === PROTOCOL && item.type === "request" && uuid(item.id)
    && ["start", "respond", "owner", "revise", "structured", "persistent-structured"].includes(item.operation) && bounded(item.prompt, REQUEST_LIMIT)
    && (!item.sessionId || bounded(item.sessionId, 200))
    && (["structured", "persistent-structured"].includes(item.operation)
      ? ["new-topic", "topic-refinement", "portrait-updates", "intake-response", "context-analysis"].includes(String(item.schema)) && !item.agent
      : item.agent && ["dima", "katya"].includes(item.agent.id)
        && bounded(item.agent.displayName, 80) && optionalBounded(item.agent.ownerName, 80) && optionalBounded(item.agent.peerName, 80)
        && bounded(item.agent.perspective, REQUEST_LIMIT) && optionalBounded(item.agent.communicationExamples, REQUEST_LIMIT)
        && (!item.agent.language || ["ru", "en", "cs", "fr"].includes(item.agent.language))));
};
const validResponse = (value: unknown, requestId: string): value is ComputeResponse => {
  const item = value as ComputeResponse | null;
  return Boolean(item && item.protocol === PROTOCOL && item.type === "response" && item.requestId === requestId
    && ["ok", "error"].includes(item.outcome) && (!item.sessionId || bounded(item.sessionId, 200)));
};

async function atomicJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  await replaceStateFile(temporary, file);
}
function parseJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(readFileSync(file, "utf8")) as T; } catch { return fallback; }
}
function invitationCode(invitation: ComputeInvitation) {
  return Buffer.from(JSON.stringify(invitation), "utf8").toString("base64url");
}
function parseInvitation(code: unknown): ComputeInvitation {
  if (typeof code !== "string" || code.length > 4096) throw new Error("Некорректное приглашение вычислительного канала");
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(code.trim(), "base64url").toString("utf8")); } catch { throw new Error("Некорректное приглашение вычислительного канала"); }
  if (!validInvitation(parsed)) throw new Error("Некорректное приглашение вычислительного канала");
  return parsed;
}

/** A deliberately narrow text-compute bridge. The public protocol cannot run
 * commands or tools: the host always constructs its own isolated Codex worker. */
export class ComputeChannelManager {
  private settings: ComputeSettings;
  private timer?: NodeJS.Timeout;
  private working = false;
  private transports = new Map<string, SupabaseTransport>();
  private subscriptions = new Map<string, () => Promise<unknown>>();
  private clientWaiters = new Map<string, Array<(response: ComputeResponse) => void>>();
  private connectivity = new Map<string, boolean>();
  private enrollmentTransport?: SupabaseTransport;
  private enrollmentSubscription?: () => Promise<unknown>;
  private enrollmentRequests: ComputeEnrollmentRequest[] = [];
  private enrollmentUnavailable = false;
  private providerRegistered?: boolean;

  constructor(
    private readonly root: string,
    private readonly resourcesPath: string,
    private readonly makeTransport: (secret: string, storage: ReturnType<typeof durableAuthStorage>, preserve: boolean) => SupabaseTransport,
    private readonly background = true,
    private readonly testRunner?: (request: ComputeRequest) => Promise<{ response?: AgentResponse; value?: unknown; sessionId?: string }>,
    private readonly notify?: (event: { type: "compute-enrollment"; requestId: string }) => void,
  ) {
    this.settings = parseJson<ComputeSettings>(path.join(root, "settings.json"), { mode: "off", channels: [] });
    if (this.background) { this.timer = setInterval(() => void this.tick(), POLL_MS); this.timer.unref(); setTimeout(() => void this.tick(), 100); }
  }

  private async saveSettings() { await atomicJson(path.join(this.root, "settings.json"), this.settings); }
  private async enrollmentKeys(): Promise<EnrollmentKeyPair> {
    const file = path.join(this.root, "enrollment-keys.json");
    const existing = parseJson<EnrollmentKeyPair | undefined>(file, undefined);
    if (existing && validEnrollmentPublicKey(existing.publicKey) && validEnrollmentPrivateKey(existing.privateKey)) return existing;
    const created = createEnrollmentKeyPair();
    await atomicJson(file, created);
    return created;
  }
  private enrollment(): SupabaseTransport {
    if (!this.enrollmentTransport) this.enrollmentTransport = this.makeTransport(
      "family-bridge-compute-enrollment-v1",
      durableAuthStorage(path.join(this.root, "enrollment")),
      false,
    );
    return this.enrollmentTransport;
  }
  private resetConnections() {
    for (const unsubscribe of this.subscriptions.values()) void unsubscribe();
    this.subscriptions.clear();
    for (const transport of this.transports.values()) transport.dispose();
    this.transports.clear();
    this.connectivity.clear();
    void this.enrollmentSubscription?.();
    this.enrollmentSubscription = undefined;
    this.enrollmentTransport?.dispose();
    this.enrollmentTransport = undefined;
    this.providerRegistered = undefined;
  }
  private channelDirectory(id: string) { return path.join(this.root, "channels", id); }
  private transport(invitation: ComputeInvitation, preserve = true) {
    const existing = this.transports.get(invitation.channelId);
    if (existing) return existing;
    const transport = this.makeTransport(invitation.invite.encryptionSecret, durableAuthStorage(this.channelDirectory(invitation.channelId)), preserve);
    this.transports.set(invitation.channelId, transport);
    return transport;
  }
  private subscribe(invitation: ComputeInvitation, transport: SupabaseTransport) {
    if (!this.subscriptions.has(invitation.channelId)) this.subscriptions.set(invitation.channelId,
      transport.subscribe(invitation.invite.pairId, () => void this.tick()));
  }

  async configureHost(name?: unknown, approvalPolicy: ComputeApprovalPolicy = "auto_accept") {
    const sponsorName = (typeof name === "string" && name.trim() || "Доверенный компьютер").slice(0, 80);
    if (!["auto_accept", "ask", "reject"].includes(approvalPolicy)) throw new Error("Некорректный режим новых подключений");
    if (this.settings.mode === "client") this.resetConnections();
    this.settings = { ...this.settings, mode: "host", sponsorName, approvalPolicy, providerConfigured: true, client: undefined, enrollment: undefined };
    await this.saveSettings();
    if (this.background) setTimeout(() => void this.tick(), 0);
    return this.snapshot();
  }

  async setApprovalPolicy(policy: unknown) {
    if (!["auto_accept", "ask", "reject"].includes(String(policy))) throw new Error("Некорректный режим новых подключений");
    if (this.settings.mode !== "host") throw new Error("Сначала включите режим доверенного компьютера");
    this.settings.approvalPolicy = policy as ComputeApprovalPolicy;
    await this.saveSettings();
    if (this.background) setTimeout(() => void this.tick(), 0);
    return this.snapshot();
  }

  async requestTrustedComputer() {
    if (this.settings.mode === "host") this.resetConnections();
    const keys = await this.enrollmentKeys();
    const request = await this.enrollment().requestDefaultComputeProvider(keys.publicKey);
    this.settings = {
      mode: "client",
      sponsorName: "Доверенный компьютер",
      channels: [],
      enrollment: {
        id: request.id,
        requesterPublicKey: request.requesterPublicKey,
        providerPublicKey: request.providerPublicKey,
        status: request.status,
        createdAt: request.createdAt,
      },
    };
    this.enrollmentUnavailable = false;
    await this.saveSettings();
    if (request.status === "approved") await this.completeEnrollment(request);
    if (this.background) setTimeout(() => void this.tick(), 0);
    return this.snapshot();
  }

  async decideEnrollment(requestId: unknown, approved: unknown) {
    if (!uuid(requestId) || typeof approved !== "boolean") throw new Error("Некорректный запрос подключения");
    if (this.settings.mode !== "host") throw new Error("Этот компьютер не принимает подключения");
    const request = this.enrollmentRequests.find(item => item.id === requestId)
      ?? (await this.enrollment().pendingComputeEnrollmentRequests()).find(item => item.id === requestId);
    if (!request) throw new Error("Запрос подключения уже обработан или не найден");
    await this.resolveEnrollment(request, approved);
    return this.snapshot();
  }

  async createInvitation(label: unknown) {
    if (this.settings.mode !== "host") throw new Error("Сначала включите режим вычислительного компьютера");
    const sponsorName = this.settings.sponsorName || "Владелец";
    const clientLabel = (typeof label === "string" && label.trim() || "Новое подключение").slice(0, 80);
    const channelId = randomUUID();
    const directory = this.channelDirectory(channelId);
    const transport = this.makeTransport(generateSharedSecret(), durableAuthStorage(directory), false);
    const creatorId = await transport.identity();
    const invite = await transport.createPair();
    transport.dispose();
    const channel: HostChannel = { protocol: 1, channelId, sponsorName, clientLabel, creatorId, invite, enabled: true, createdAt: new Date().toISOString() };
    this.settings = { ...this.settings, channels: [...this.settings.channels, channel] };
    await this.saveSettings();
    if (this.background) setTimeout(() => void this.tick(), 0);
    return { code: invitationCode(channel), channelId, sponsorName };
  }

  private async createChannel(label: string, enrollmentRequestId?: string): Promise<HostChannel> {
    const sponsorName = this.settings.sponsorName || "Доверенный компьютер";
    const channelId = randomUUID();
    const directory = this.channelDirectory(channelId);
    const transport = this.makeTransport(generateSharedSecret(), durableAuthStorage(directory), false);
    const creatorId = await transport.identity();
    const invite = await transport.createPair();
    transport.dispose();
    const channel: HostChannel = {
      protocol: 1,
      channelId,
      sponsorName,
      clientLabel: label.slice(0, 80),
      creatorId,
      invite,
      enabled: true,
      createdAt: new Date().toISOString(),
      enrollmentRequestId,
    };
    this.settings = { ...this.settings, channels: [...this.settings.channels, channel] };
    await this.saveSettings();
    return channel;
  }

  private async resolveEnrollment(request: ComputeEnrollmentRequest, approved: boolean) {
    if (!approved) {
      await this.enrollment().decideComputeEnrollmentRequest(request.id, false);
      this.enrollmentRequests = this.enrollmentRequests.filter(item => item.id !== request.id);
      return;
    }
    if (!validEnrollmentPublicKey(request.requesterPublicKey)) throw new Error("Некорректный ключ запроса подключения");
    const keys = await this.enrollmentKeys();
    const channel = this.settings.channels.find(item => item.enrollmentRequestId === request.id)
      ?? await this.createChannel(`Подключение ${request.id.slice(0, 8)}`, request.id);
    const response = sealEnrollmentPayload(channel, keys.privateKey, request.requesterPublicKey);
    // The request and its channel are idempotent. If the response is lost while the
    // server is offline, keep the channel enabled and publish the same sealed invite
    // on the next tick instead of creating a dead connection.
    await this.enrollment().decideComputeEnrollmentRequest(request.id, true, response);
    this.enrollmentRequests = this.enrollmentRequests.filter(item => item.id !== request.id);
  }

  private async completeEnrollment(request: ComputeEnrollmentRequest) {
    if (!request.responsePayload || !validEnrollmentPublicKey(request.providerPublicKey)) throw new Error("Доверенный компьютер вернул некорректный ответ");
    const keys = await this.enrollmentKeys();
    const invitation = openEnrollmentPayload<ComputeInvitation>(request.responsePayload, keys.privateKey, request.providerPublicKey);
    if (!validInvitation(invitation)) throw new Error("Доверенный компьютер вернул некорректное подключение");
    await this.join(invitationCode(invitation));
    this.settings.enrollment = {
      id: request.id,
      requesterPublicKey: request.requesterPublicKey,
      providerPublicKey: request.providerPublicKey,
      status: "approved",
      createdAt: request.createdAt,
    };
    await this.saveSettings();
  }

  async join(code: unknown) {
    const invitation = parseInvitation(code);
    this.resetConnections();
    const transport = this.makeTransport(invitation.invite.encryptionSecret, durableAuthStorage(this.channelDirectory(invitation.channelId)), false);
    await transport.identity();
    try { await transport.joinPair(invitation.invite); } catch { /* A lost join response is checked below. */ }
    const pair = await transport.pairState(invitation.invite.pairId);
    if (pair.owner_id !== invitation.creatorId || !pair.partner_id) throw new Error("Вычислительный канал не подключён");
    transport.dispose();
    this.connectivity.set(invitation.channelId, true);
    this.settings = { mode: "client", sponsorName: invitation.sponsorName, channels: [], client: { invitation, joinedAt: new Date().toISOString(), enabled: true } };
    await this.saveSettings();
    if (this.background) setTimeout(() => void this.tick(), 0);
    return this.snapshot();
  }

  async disable() {
    const wasProvider = this.settings.mode === "host" || this.settings.providerConfigured === true;
    this.resetConnections();
    this.settings = { mode: "off", channels: this.settings.channels, ...(wasProvider ? { providerConfigured: true, approvalPolicy: this.settings.approvalPolicy } : {}) };
    await this.saveSettings();
    if (wasProvider) await this.syncProviderRegistration(false).catch(() => undefined);
    return this.snapshot();
  }

  async revoke(channelId: unknown) {
    if (!uuid(channelId)) throw new Error("Некорректный канал");
    this.settings = { ...this.settings, channels: this.settings.channels.map(channel => channel.channelId === channelId ? { ...channel, enabled: false } : channel) };
    this.transports.get(channelId)?.dispose(); this.transports.delete(channelId);
    await this.subscriptions.get(channelId)?.().catch(() => undefined); this.subscriptions.delete(channelId);
    await this.saveSettings();
    return this.snapshot();
  }

  isClient() { return this.settings.mode === "client" && this.settings.client?.enabled === true; }

  createAgent(conversationId: string, options: Omit<CodexRuntimeOptions, "workspace" | "schemaPath" | "codexCommand" | "model" | "reasoningEffort">): AgentRuntime {
    return new RemoteComputeAgent(this, conversationId, options);
  }

  async execute(key: string, request: Omit<ComputeRequest, "protocol" | "type" | "id" | "createdAt">): Promise<ComputeResponse> {
    const binding = this.settings.client;
    if (this.settings.mode !== "client" || !binding?.enabled) throw Object.assign(new Error("Вычислительный канал не настроен"), { code: "COMPUTE_UNAVAILABLE" });
    const jobsFile = path.join(this.root, "client-jobs.json");
    const jobs = parseJson<Record<string, ClientJob>>(jobsFile, {});
    let job = jobs[key];
    if (!job) {
      const id = randomUUID();
      job = { key, request: { ...request, protocol: 1, type: "request", id, createdAt: new Date().toISOString() }, updatedAt: new Date().toISOString() };
      jobs[key] = job;
      await atomicJson(jobsFile, jobs);
    }
    if (job.response) return job.response;
    await this.tick();
    const refreshed = parseJson<Record<string, ClientJob>>(jobsFile, {})[key];
    if (refreshed?.response) return refreshed.response;
    return new Promise<ComputeResponse>((resolve, reject) => {
      const waiters = this.clientWaiters.get(key) ?? [];
      waiters.push(resolve); this.clientWaiters.set(key, waiters);
      const timeout = setTimeout(() => {
        const current = this.clientWaiters.get(key) ?? [];
        this.clientWaiters.set(key, current.filter(item => item !== resolve));
        reject(Object.assign(new Error("Задание сохранено. Вычислительный компьютер пока недоступен; отправка повторится автоматически."), { code: "COMPUTE_PENDING" }));
      }, 180_000);
      timeout.unref();
    });
  }

  async executeStructured(key: string, schema: ComputeSchema, prompt: string): Promise<unknown> {
    const result = await this.execute(key, { operation: "structured", schema, prompt });
    if (result.outcome !== "ok" || result.value === undefined) {
      const pending = result.code === "COMPUTE_LIMIT";
      throw Object.assign(new Error(pending ? "Лимит вычислительного компьютера временно исчерпан. Задание сохранено." : "Вычислительный компьютер не смог обработать задание. Оно сохранено для повтора."), { code: pending ? "CODEX_USAGE_LIMIT" : "COMPUTE_FAILED" });
    }
    return result.value;
  }

  async executePersistentStructured(key: string, schema: "intake-response" | "context-analysis", prompt: string, sessionId?: string) {
    const result = await this.execute(key, { operation: "persistent-structured", schema, prompt, sessionId });
    if (result.outcome !== "ok" || result.value === undefined) {
      const pending = result.code === "COMPUTE_LIMIT";
      throw Object.assign(new Error(pending ? "Лимит доверенного компьютера временно исчерпан. Сообщение сохранено." : "Доверенный компьютер не смог обработать сообщение. Оно сохранено для повтора."), { code: pending ? "CODEX_USAGE_LIMIT" : "COMPUTE_FAILED" });
    }
    return { value: result.value, sessionId: result.sessionId };
  }

  async state(): Promise<ComputeState> {
    await this.tick();
    return this.snapshot();
  }

  snapshot(): ComputeState {
    const jobs = parseJson<Record<string, ClientJob>>(path.join(this.root, "client-jobs.json"), {});
    const clientConnected = this.settings.client ? this.connectivity.get(this.settings.client.invitation.channelId) ?? false : false;
    const hostConnected = this.settings.channels.some(channel => this.connectivity.get(channel.channelId));
    const enrollmentStatus = this.enrollmentUnavailable && this.settings.enrollment?.status === "pending"
      ? "unavailable"
      : this.settings.client?.enabled ? "approved" : this.settings.enrollment?.status ?? "idle";
    return { mode: this.settings.mode, sponsorName: this.settings.sponsorName, connected: this.settings.mode === "client" ? clientConnected : this.settings.mode === "host" ? hostConnected : false,
      pending: Object.values(jobs).filter(job => !job.response).length,
      approvalPolicy: this.settings.approvalPolicy ?? "auto_accept",
      enrollmentStatus,
      requests: this.enrollmentRequests.map(request => ({ id: request.id, createdAt: request.createdAt })),
      channels: this.settings.channels.map(channel => ({ channelId: channel.channelId, label: channel.clientLabel || channel.sponsorName,
        enabled: channel.enabled, connected: this.connectivity.get(channel.channelId) ?? false, createdAt: channel.createdAt })) };
  }

  private async tick() {
    if (this.working) return;
    this.working = true;
    try {
      if (this.settings.providerConfigured) await this.syncProviderRegistration(this.settings.mode === "host").catch(() => undefined);
      if (this.settings.mode === "host") {
        await this.pollEnrollments().catch(() => undefined);
        await Promise.allSettled(this.settings.channels.filter(item => item.enabled).map(channel => this.pollHost(channel)));
      }
      if (this.settings.mode === "client") {
        if (!this.settings.client?.enabled && this.settings.enrollment) await this.pollEnrollmentRequest();
        if (this.settings.client?.enabled) await this.pollClient(this.settings.client);
      }
    } catch { /* Offline and sleeping computers are expected. */ }
    finally { this.working = false; }
  }

  private async syncProviderRegistration(enabled: boolean) {
    if (this.providerRegistered === enabled) return;
    const transport = this.enrollment();
    const keys = await this.enrollmentKeys();
    await transport.registerDefaultComputeProvider(keys.publicKey, enabled);
    this.providerRegistered = enabled;
  }

  private async pollEnrollments() {
    const transport = this.enrollment();
    await this.syncProviderRegistration(true);
    if (!this.enrollmentSubscription) {
      const providerId = await transport.identity();
      this.enrollmentSubscription = transport.subscribeComputeEnrollments(providerId, () => void this.tick());
    }
    const previous = new Set(this.enrollmentRequests.map(item => item.id));
    const requests = await transport.pendingComputeEnrollmentRequests();
    const policy = this.settings.approvalPolicy ?? "auto_accept";
    if (policy === "auto_accept") {
      for (const request of requests) await this.resolveEnrollment(request, true);
      this.enrollmentRequests = [];
    } else if (policy === "reject") {
      for (const request of requests) await this.resolveEnrollment(request, false);
      this.enrollmentRequests = [];
    } else {
      this.enrollmentRequests = requests;
      for (const request of requests) if (!previous.has(request.id)) this.notify?.({ type: "compute-enrollment", requestId: request.id });
    }
  }

  private async pollEnrollmentRequest() {
    const saved = this.settings.enrollment;
    if (!saved || saved.status !== "pending") return;
    try {
      const current = await this.enrollment().computeEnrollmentRequest(saved.id);
      saved.status = current.status;
      this.enrollmentUnavailable = false;
      await this.saveSettings();
      if (current.status === "approved") await this.completeEnrollment(current);
    } catch {
      this.enrollmentUnavailable = true;
    }
  }

  private async pollClient(binding: ClientBinding) {
    const transport = this.transport(binding.invitation);
    const pair = await transport.pairState(binding.invitation.invite.pairId);
    this.subscribe(binding.invitation, transport);
    const me = await transport.identity();
    const host = pair.owner_id === me ? pair.partner_id : pair.owner_id;
    if (!host) return;
    this.connectivity.set(binding.invitation.channelId, true);
    const file = path.join(this.root, "client-jobs.json");
    const jobs = parseJson<Record<string, ClientJob>>(file, {});
    let changed = false;
    for (const job of Object.values(jobs).filter(item => !item.response)) {
      if (!job.sent) {
        await transport.send({ pairId: pair.id, conversationId: job.request.id, sequence: 1, recipientId: host, senderAgent: job.request.agent?.id ?? "dima", payload: job.request, idempotencyKey: `compute-v1:${job.request.id}:request` });
        job.sent = true; job.updatedAt = new Date().toISOString(); changed = true;
      }
      const rows = await transport.readConversation(pair.id, job.request.id);
      const result = rows.find(row => row.recipient_id === me && validResponse(row.payload, job.request.id));
      if (result && validResponse(result.payload, job.request.id)) {
        job.response = result.payload; job.updatedAt = new Date().toISOString(); changed = true;
        await transport.acknowledge(result.id).catch(() => undefined);
        for (const resolve of this.clientWaiters.get(job.key) ?? []) resolve(result.payload);
        this.clientWaiters.delete(job.key);
      }
    }
    if (changed) await atomicJson(file, jobs);
  }

  private async pollHost(channel: HostChannel) {
    const transport = this.transport(channel);
    const pair = await transport.pairState(channel.invite.pairId);
    this.subscribe(channel, transport);
    const me = await transport.identity();
    if (me !== channel.creatorId || pair.owner_id !== channel.creatorId || !pair.partner_id) return;
    this.connectivity.set(channel.channelId, true);
    const envelope = await transport.readClaimedReceived(pair.id) ?? await transport.claimNext(pair.id);
    if (!envelope || envelope.recipient_id !== me) return;
    await this.handleHostEnvelope(channel, transport, pair.partner_id, envelope);
  }

  private async handleHostEnvelope(channel: HostChannel, transport: SupabaseTransport, peer: string, envelope: RemoteEnvelope) {
    const resultFile = path.join(this.channelDirectory(channel.channelId), "results", `${envelope.id}.json`);
    let saved = parseJson<SavedHostResult | undefined>(resultFile, undefined);
    if (saved?.retryAt && saved.retryAt > Date.now()) return;
    if (!saved?.response) {
      const response = validRequest(envelope.payload) ? await this.runRequest(channel, envelope.payload) : {
        protocol: 1 as const, type: "response" as const, requestId: (envelope.payload as { id?: string } | null)?.id ?? randomUUID(), outcome: "error" as const, code: "COMPUTE_INVALID" as const,
      };
      saved = response.code === "COMPUTE_LIMIT"
        ? { retryAt: Date.now() + 15 * 60_000, recipientId: peer, conversationId: envelope.conversation_id, createdAt: new Date().toISOString() }
        : { response, recipientId: peer, conversationId: envelope.conversation_id, createdAt: new Date().toISOString() };
      await atomicJson(resultFile, saved);
    }
    if (!saved.response) return;
    await transport.send({ pairId: channel.invite.pairId, conversationId: saved.conversationId, sequence: 2, recipientId: saved.recipientId,
      senderAgent: envelope.sender_agent === "dima" ? "katya" : "dima", payload: saved.response, idempotencyKey: `compute-v1:${saved.response.requestId}:response` });
    await transport.acknowledge(envelope.id);
  }

  private async runRequest(channel: HostChannel, request: ComputeRequest): Promise<ComputeResponse> {
    try {
      if (this.testRunner) {
        const result = await this.testRunner(request);
        return ["structured", "persistent-structured"].includes(request.operation)
          ? { protocol: 1, type: "response", requestId: request.id, outcome: "ok", value: result.value, sessionId: result.sessionId }
          : { protocol: 1, type: "response", requestId: request.id, outcome: "ok", response: result.response, sessionId: result.sessionId };
      }
      const workspace = request.operation === "persistent-structured"
        ? path.join(this.channelDirectory(channel.channelId), "project")
        : path.join(this.channelDirectory(channel.channelId), "work", request.id);
      if (request.operation === "structured") {
        const { value } = await this.runStructured(workspace, request.schema!, request.prompt, undefined, true);
        return { protocol: 1, type: "response", requestId: request.id, outcome: "ok", value };
      }
      if (request.operation === "persistent-structured") {
        const result = await this.runStructured(workspace, request.schema!, request.prompt, request.sessionId, false);
        return { protocol: 1, type: "response", requestId: request.id, outcome: "ok", value: result.value, sessionId: result.sessionId };
      }
      const options: CodexRuntimeOptions = {
        ...request.agent!,
        workspace,
        schemaPath: path.join(this.resourcesPath, "schemas", "agent-response.schema.json"),
        model: "gpt-5.6-luna",
        reasoningEffort: "medium",
        sessionId: request.sessionId,
      };
      const agent = new CodexCliAgent(options);
      const response = request.operation === "start" ? await agent.start(request.prompt)
        : request.operation === "respond" ? await agent.respond(request.prompt)
          : request.operation === "owner" ? await agent.respondToOwner(request.prompt)
            : await agent.revise(request.prompt);
      return { protocol: 1, type: "response", requestId: request.id, outcome: "ok", response, sessionId: agent.currentSessionId };
    } catch (error) {
      const code = (error as { code?: string }).code === "CODEX_USAGE_LIMIT" ? "COMPUTE_LIMIT" : "COMPUTE_FAILED";
      return { protocol: 1, type: "response", requestId: request.id, outcome: "error", code };
    }
  }

  private async runStructured(workspace: string, schema: ComputeSchema, prompt: string, sessionId?: string, ephemeral = true): Promise<{ value: unknown; sessionId?: string }> {
    await mkdir(workspace, { recursive: true });
    const command = defaultCodexCommand();
    const schemaPath = path.join(this.resourcesPath, "schemas", `${schema}.schema.json`);
    const args = isolatedCodexInvocation(sessionId
      ? ["exec", "resume", "--model", "gpt-5.6-luna", ...codexReasoningArgs("medium"), "--skip-git-repo-check", "--json", "--output-schema", schemaPath, sessionId, "-"]
      : ["exec", "--model", "gpt-5.6-luna", ...codexReasoningArgs("medium"), ...(ephemeral ? ["--ephemeral"] : []), "--skip-git-repo-check", "-s", "read-only", "--json", "--output-schema", schemaPath, "-C", workspace, "-"]);
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd: workspace, windowsHide: true, shell: process.platform === "win32" && command.toLowerCase().endsWith(".cmd") });
      child.stdin.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") reject(error); });
      child.stdin.end(prompt);
      let stdout = "", stderr = "";
      const timeout = setTimeout(() => { child.kill(); reject(new Error("Вычислительное задание не завершилось вовремя")); }, 15 * 60_000);
      child.stdout.on("data", chunk => { stdout += chunk.toString(); });
      child.stderr.on("data", chunk => { stderr += chunk.toString(); });
      child.once("error", error => { clearTimeout(timeout); reject(error); });
      child.on("close", code => {
        clearTimeout(timeout);
        if (code !== 0) { reject(codexTaskFailure("Вычислительное задание", code, stderr || stdout)); return; }
        try {
          let finalText = "", threadId: string | undefined;
          for (const line of stdout.split(/\r?\n/)) {
            if (!line.trim().startsWith("{")) continue;
            const event = JSON.parse(line) as { type?: string; thread_id?: string; item?: { type?: string; text?: string }; message?: string };
            if (event.type === "thread.started") threadId = event.thread_id;
            if (event.type === "item.completed" && event.item?.type === "agent_message") finalText = event.item.text ?? "";
            if (event.type === "error") throw new Error(event.message ?? "Вычислительное задание не выполнено");
          }
          if (!finalText) throw new Error("Вычислительный компьютер не вернул результат");
          resolve({ value: JSON.parse(finalText), sessionId: sessionId ?? threadId });
        } catch (error) { reject(error); }
      });
    });
  }

  dispose() { if (this.timer) clearInterval(this.timer); this.resetConnections(); }
}

class RemoteComputeAgent implements AgentRuntime {
  readonly id: "dima" | "katya";
  private sessionId?: string;
  constructor(private readonly manager: ComputeChannelManager, private readonly conversationId: string,
    private readonly options: Omit<CodexRuntimeOptions, "workspace" | "schemaPath" | "codexCommand" | "model" | "reasoningEffort">) { this.id = options.id; }

  start(prompt: string) { return this.run("start", prompt); }
  respond(prompt: string, guidance = "") { return this.run("respond", guidance ? `${prompt}\n\n${guidance}` : prompt); }
  respondToOwner(prompt: string) { return this.run("owner", prompt); }
  revise(prompt: string) { return this.run("revise", prompt); }

  private async run(operation: ComputeOperation, prompt: string) {
    const key = createHash("sha256").update(JSON.stringify([this.conversationId, operation, this.sessionId, prompt])).digest("hex");
    const result = await this.manager.execute(key, { operation, sessionId: this.sessionId, prompt, agent: this.options });
    if (result.outcome !== "ok" || !result.response) {
      const pending = result.code === "COMPUTE_LIMIT";
      throw Object.assign(new Error(pending ? "Лимит вычислительного компьютера временно исчерпан. Задание сохранено." : "Вычислительный компьютер не смог обработать задание. Оно сохранено для повтора."), { code: pending ? "CODEX_USAGE_LIMIT" : "COMPUTE_FAILED" });
    }
    this.sessionId = result.sessionId;
    return result.response;
  }
}
