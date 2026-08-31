import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import type { BrowserWindow } from "electron";
import { CodexCliAgent, defaultCodexCommand } from "../src/core/codex-runtime.js";
import { CodexHistoryClient, type ContextThread } from "../src/core/codex-history.js";
import { CodexAppHistoryClient } from "../src/core/codex-app-history.js";
import { CodexContextAnalyzer, contextSourceHash, routeSensitivity, topicsForCounterpart, type ContextAnalysis } from "../src/core/context-analysis.js";
import { ConversationCoordinator, type CoordinatorEvent } from "../src/core/coordinator.js";
import { MockAgent } from "../src/core/mock-runtime.js";
import { SupabaseTransport, type AuthStorage, type PairingInvite, type RemoteEnvelope } from "../src/core/supabase-transport.js";
import type { AgentResponse, AgentRuntime, ConversationReport } from "../src/core/types.js";
import { AtomicStore, type AppLanguage, type OwnerId } from "./store.js";

const execFileAsync = promisify(execFile);

interface ContextSource extends ContextThread {
  lastSyncedAt?: string;
  messageCount?: number;
  status?: "ready" | "syncing" | "error";
  error?: string;
}

interface TopicPayload {
  kind: "topic";
  topic: string;
  senderName?: string;
}

interface DialoguePayload {
  kind?: "dialogue";
  text: string;
  topic: string;
  status: string;
  sharedSummary?: string;
  senderName?: string;
}

export class BackgroundService {
  private running = false;
  private remote?: SupabaseTransport;
  private remoteTimer?: NodeJS.Timeout;
  private contextTimer?: NodeJS.Timeout;
  private syncedTopicsForPair?: string;
  private remoteBusy = false;
  private readonly remoteAgents = new Map<string, AgentRuntime>();
  private readonly remoteMessages = new Map<string, Array<{ from: "dima" | "katya"; text: string }>>();

  private static readonly supabaseUrl = "https://knqaygvvqrwmtyqucbsz.supabase.co";
  private static readonly supabaseKey = "sb_publishable_igxXq8mdFjW-wKJGSKhtnA_iINygezS";

  constructor(
    private readonly userData: string,
    private readonly resourcesPath: string,
    private readonly store: AtomicStore,
    private readonly windowProvider: () => BrowserWindow | null,
  ) {}

  async state() {
    const stored = await this.store.read();
    const codex = await this.codexStatus();
    let connected = false;
    if (stored.remote && this.remote) {
      try { connected = Boolean((await this.remote.pairState(stored.remote.pairId)).partner_id); } catch { connected = false; }
    }
    const invite = stored.remote?.inviteSecret ? Buffer.from(JSON.stringify({
      version: 1, pairId: stored.remote.pairId, inviteSecret: stored.remote.inviteSecret,
      encryptionSecret: stored.remote.encryptionSecret, participantName: stored.displayName,
    })).toString("base64url") : undefined;
    const memoryRoot = path.join(this.userData, "psychologist-memory");
    let memory = { configured: false, messageCount: 0, lastCheckedAt: undefined as string | undefined, status: undefined as string | undefined };
    try {
      const raw = JSON.parse(readFileSync(path.join(memoryRoot, "sync-state.json"), "utf8")) as { transcript_message_count?: number; last_checked_at?: string; status?: string };
      memory = { configured: true, messageCount: raw.transcript_message_count ?? 0, lastCheckedAt: raw.last_checked_at, status: raw.status };
    } catch { /* memory is optional during setup */ }
    const context = this.readContextSource();
    const contextAnalysis = this.readContextAnalysis();
    const counterpart = contextAnalysis?.people.find((person) => person.id === stored.remote?.counterpartPersonId);
    return { ...stored, codex, running: this.running, memory, context, contextAnalysis, update: { available: false, downloading: false }, remote: { configured: Boolean(stored.remote), connected, pairId: stored.remote?.pairId, invite, peerName: stored.remote?.peerName, counterpartPersonId: stored.remote?.counterpartPersonId, counterpartLabel: counterpart?.label } };
  }

  async listContextThreads() {
    const codex = new CodexHistoryClient(defaultCodexCommand());
    const localThreads = await codex.listThreads();
    const callingThreadId = localThreads[0]?.id;
    if (!callingThreadId) return localThreads;
    try {
      const chatGptThreads = await new CodexAppHistoryClient(callingThreadId).listThreads();
      return [...chatGptThreads, ...localThreads];
    } catch {
      return localThreads;
    }
  }

  async selectContextThread(threadId: unknown) {
    if (typeof threadId !== "string" || !threadId.trim()) throw new Error("Выберите базовый чат");
    const threads = await this.listContextThreads();
    const selected = threads.find((thread) => thread.id === threadId);
    if (!selected) throw new Error("Выбранный чат больше не найден в Codex");
    const syncing: ContextSource = { ...selected, status: "syncing" };
    await this.store.update({ onboardingComplete: false });
    await this.writeContextSource(syncing);
    this.emit({ type: "context", context: syncing });
    return this.syncContext();
  }

  async syncContext() {
    const selected = this.readContextSource();
    if (!selected?.id) throw new Error("Сначала выберите базовый чат");
    try {
      const messages = selected.source === "chatgpt"
        ? await this.readChatGptMessages(selected.id)
        : await new CodexHistoryClient(defaultCodexCommand()).readUserMessages(selected.id);
      const memoryRoot = path.join(this.userData, "psychologist-memory");
      await mkdir(memoryRoot, { recursive: true });
      const samples = path.join(memoryRoot, "style-samples.jsonl");
      const temporary = `${samples}.tmp`;
      await writeFile(temporary, messages.map((message) => JSON.stringify(message)).join("\n") + (messages.length ? "\n" : ""), "utf8");
      await rename(temporary, samples);
      const completed: ContextSource = { ...selected, lastSyncedAt: new Date().toISOString(), messageCount: messages.length, status: "ready", error: undefined };
      await this.writeContextSource(completed);
      this.emit({ type: "context", context: completed });
      const hash = contextSourceHash(messages);
      const previous = this.readContextAnalysis();
      if (!previous || previous.sourceId !== selected.id || previous.sourceHash !== hash || previous.status !== "ready") {
        await this.analyzeContext(selected.id, hash, messages, previous?.sourceId === selected.id ? previous : undefined);
      }
      return this.state();
    } catch (error) {
      const failed: ContextSource = { ...selected, status: "error", error: error instanceof Error ? error.message : String(error) };
      await this.writeContextSource(failed);
      this.emit({ type: "context", context: failed });
      throw error;
    }
  }

  private async readChatGptMessages(threadId: string) {
    const localThreads = await new CodexHistoryClient(defaultCodexCommand()).listThreads();
    const callingThreadId = localThreads[0]?.id;
    if (!callingThreadId) throw new Error("Codex Desktop не нашёл локальную задачу для доступа к чатам ChatGPT");
    return new CodexAppHistoryClient(callingThreadId).readUserMessages(threadId);
  }

  private contextSourcePath() {
    return path.join(this.userData, "psychologist-memory", "context-source.json");
  }

  private readContextSource(): ContextSource | undefined {
    try { return JSON.parse(readFileSync(this.contextSourcePath(), "utf8")) as ContextSource; }
    catch { return undefined; }
  }

  private async writeContextSource(source: ContextSource) {
    const file = this.contextSourcePath();
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    await writeFile(temporary, JSON.stringify(source, null, 2), "utf8");
    await rename(temporary, file);
  }

  private contextAnalysisPath() {
    return path.join(this.userData, "psychologist-memory", "context-analysis.json");
  }

  private readContextAnalysis(): ContextAnalysis | undefined {
    try { return JSON.parse(readFileSync(this.contextAnalysisPath(), "utf8")) as ContextAnalysis; }
    catch { return undefined; }
  }

  private async writeContextAnalysis(analysis: ContextAnalysis) {
    const file = this.contextAnalysisPath();
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    await writeFile(temporary, JSON.stringify(analysis, null, 2), "utf8");
    await rename(temporary, file);
  }

  private async analyzeContext(sourceId: string, sourceHash: string, messages: Array<{ text: string }>, previous?: ContextAnalysis) {
    const analyzing: ContextAnalysis = { sourceId, sourceHash, analyzedAt: new Date().toISOString(), status: "analyzing", people: previous?.people ?? [], topics: previous?.topics ?? [] };
    await this.writeContextAnalysis(analyzing);
    this.emit({ type: "context-analysis", analysis: analyzing });
    try {
      const stored = await this.store.read();
      const analyzer = new CodexContextAnalyzer(defaultCodexCommand(), path.join(this.userData, "context-analysis"), path.join(this.resourcesPath, "schemas", "context-analysis.schema.json"));
      const analysis = await analyzer.analyze({
        sourceId, sourceHash, ownerName: stored.displayName, language: stored.language, messages, previous,
        onProgress: async (progress) => {
          analyzing.progress = progress;
          const progressing: ContextAnalysis = { ...analyzing, progress };
          await this.writeContextAnalysis(progressing);
          this.emit({ type: "context-analysis", analysis: progressing });
        },
      });
      await this.writeContextAnalysis(analysis);
      this.emit({ type: "context-analysis", analysis });
      return analysis;
    } catch (error) {
      const failed: ContextAnalysis = { ...analyzing, status: "error", error: error instanceof Error ? error.message : String(error) };
      await this.writeContextAnalysis(failed);
      this.emit({ type: "context-analysis", analysis: failed });
      throw error;
    }
  }

  async updateContextTopic(input: unknown) {
    const value = input && typeof input === "object" ? input as { topicId?: unknown; aboutPersonIds?: unknown; discussWithPersonId?: unknown; approved?: unknown } : {};
    if (typeof value.topicId !== "string") throw new Error("Тема не найдена");
    const analysis = this.readContextAnalysis();
    if (!analysis) throw new Error("Сначала проанализируйте базовый чат");
    const topic = analysis.topics.find((item) => item.id === value.topicId);
    if (!topic) throw new Error("Тема не найдена");
    if (typeof value.discussWithPersonId === "string") {
      if (!analysis.people.some((person) => person.id === value.discussWithPersonId)) throw new Error("Адресат темы не найден");
      topic.discussWithPersonId = value.discussWithPersonId;
    }
    if (Array.isArray(value.aboutPersonIds)) {
      const aboutPersonIds = value.aboutPersonIds.filter((item): item is string => typeof item === "string");
      if (!aboutPersonIds.length || aboutPersonIds.some((personId) => !analysis.people.some((person) => person.id === personId))) {
        throw new Error("Выберите, о ком эта тема");
      }
      topic.aboutPersonIds = [...new Set(aboutPersonIds)];
    }
    topic.sensitivity = routeSensitivity(topic.aboutPersonIds, topic.discussWithPersonId);
    if (typeof value.approved === "boolean") topic.approved = value.approved;
    await this.writeContextAnalysis(analysis);
    this.emit({ type: "context-analysis", analysis });
    const stored = await this.store.read();
    let pendingTopics = stored.pendingTopics.filter((item) => item !== topic.title);
    if (topic.approved && topic.discussWithPersonId === stored.remote?.counterpartPersonId) pendingTopics = [...new Set([...pendingTopics, topic.title])];
    await this.store.update({ pendingTopics });
    this.emit({ type: "topics", topics: pendingTopics });
    if (pendingTopics.includes(topic.title)) {
      try { await this.shareTopic(topic.title); } catch { /* it will also be shared when the pair becomes available */ }
    }
    return this.state();
  }

  async updateContextTopics(input: unknown) {
    const value = input && typeof input === "object" ? input as { topicIds?: unknown; approved?: unknown } : {};
    if (!Array.isArray(value.topicIds) || typeof value.approved !== "boolean") throw new Error("Не удалось изменить темы");
    const topicIds = new Set(value.topicIds.filter((item): item is string => typeof item === "string"));
    const analysis = this.readContextAnalysis();
    if (!analysis) throw new Error("Сначала проанализируйте базовый чат");
    const changed = analysis.topics.filter((topic) => topicIds.has(topic.id));
    for (const topic of changed) topic.approved = value.approved;
    await this.writeContextAnalysis(analysis);
    this.emit({ type: "context-analysis", analysis });
    const stored = await this.store.read();
    const changedTitles = new Set(changed.map((topic) => topic.title));
    let pendingTopics = stored.pendingTopics.filter((title) => !changedTitles.has(title));
    const activated = changed.filter((topic) => topic.approved && topic.discussWithPersonId === stored.remote?.counterpartPersonId).map((topic) => topic.title);
    pendingTopics = [...new Set([...pendingTopics, ...activated])];
    await this.store.update({ pendingTopics });
    this.emit({ type: "topics", topics: pendingTopics });
    for (const title of activated) {
      try { await this.shareTopic(title); } catch { /* it will also be shared when the pair becomes available */ }
    }
    return this.state();
  }

  async start() {
    const state = await this.store.read();
    if (state.remote) this.configureRemote(state.remote.encryptionSecret);
    if (this.readContextSource()?.id) {
      void this.syncContext().catch(() => undefined);
      this.contextTimer = setInterval(() => void this.syncContext().catch(() => undefined), 6 * 60 * 60 * 1_000);
    }
  }

  async setDisplayName(value: unknown) {
    const displayName = typeof value === "string" ? value.trim() : "";
    if (!displayName || displayName.length > 50) throw new Error("Введите имя длиной от 1 до 50 символов");
    await this.store.update({ displayName, identityConfigured: true });
    return this.state();
  }

  async setLanguage(language: unknown) {
    if (language !== "ru" && language !== "en" && language !== "cs" && language !== "fr") {
      throw new Error("Неизвестный язык приложения");
    }
    await this.store.update({ language });
    return this.state();
  }

  async completeOnboarding() {
    const context = this.readContextSource();
    const analysis = this.readContextAnalysis();
    if (context?.status !== "ready" || analysis?.status !== "ready" || !analysis.people.length) {
      throw new Error("Сначала выберите базовый чат и проверьте найденных людей и темы");
    }
    await this.store.update({ onboardingComplete: true });
    return this.state();
  }

  private requireCounterpartPerson(value: unknown): string {
    if (typeof value !== "string" || !value) throw new Error("Выберите, к кому подключается второй компьютер");
    const analysis = this.readContextAnalysis();
    if (!analysis?.people.some((person) => person.id === value)) throw new Error("Выбранный человек не найден в контексте");
    return value;
  }

  async createPair(counterpartPersonIdValue: unknown) {
    const stored = await this.store.read();
    if (!stored.identityConfigured) throw new Error("Сначала укажите, как вас называть");
    const counterpartPersonId = this.requireCounterpartPerson(counterpartPersonIdValue);
    const transport = this.configureRemote("");
    const invite = await transport.createPair();
    await this.store.update({ owner: "dima", remote: { pairId: invite.pairId, encryptionSecret: invite.encryptionSecret, inviteSecret: invite.inviteSecret, counterpartPersonId } });
    this.configureRemote(invite.encryptionSecret);
    await this.activateContextTopics(counterpartPersonId);
    return this.state();
  }

  async joinPair(encoded: string, counterpartPersonIdValue: unknown) {
    const stored = await this.store.read();
    if (!stored.identityConfigured) throw new Error("Сначала укажите, как вас называть");
    const counterpartPersonId = this.requireCounterpartPerson(counterpartPersonIdValue);
    const invite = JSON.parse(Buffer.from(encoded.trim(), "base64url").toString("utf8")) as PairingInvite & { participantName?: string };
    const transport = this.configureRemote(invite.encryptionSecret);
    await transport.joinPair(invite);
    await this.store.update({ owner: "katya", remote: { pairId: invite.pairId, encryptionSecret: invite.encryptionSecret, peerName: invite.participantName?.trim() || undefined, counterpartPersonId } });
    await this.activateContextTopics(counterpartPersonId);
    return this.state();
  }

  private async activateContextTopics(counterpartPersonId: string) {
    const titles = topicsForCounterpart(this.readContextAnalysis(), counterpartPersonId).map((topic) => topic.title);
    const pendingTopics = [...new Set(titles)];
    await this.store.update({ pendingTopics });
    this.emit({ type: "topics", topics: pendingTopics });
  }

  async runRemote(topic: string) {
    await this.startRemoteConversation(topic);
    const stored = await this.store.read();
    const pendingTopics = stored.pendingTopics.filter((item) => item !== topic);
    await this.store.update({ pendingTopics, lastConversationAt: new Date().toISOString() });
    this.emit({ type: "topics", topics: pendingTopics });
  }

  async discussAllTopics() {
    if (this.running) throw new Error("Обсуждение уже запущено");
    const stored = await this.store.read();
    if (!stored.identityConfigured) throw new Error("Сначала укажите, как вас называть");
    if (!stored.remote || !this.remote) throw new Error("Сначала соедините два приложения");
    if (!stored.pendingTopics.length) throw new Error("Сначала добавьте хотя бы одну тему");
    const pair = await this.remote.pairState(stored.remote.pairId);
    if (!pair.partner_id) throw new Error("Второй участник ещё не подключился");
    const topics = [...stored.pendingTopics];
    this.running = true;
    this.emit({ type: "runtime", running: true });
    await this.store.update({ pendingTopics: [] });
    this.emit({ type: "topics", topics: [] });
    try {
      const results = await Promise.allSettled(topics.map((topic) => this.startRemoteConversation(topic)));
      const failed = topics.filter((_topic, index) => results[index].status === "rejected");
      if (failed.length) {
        const current = await this.store.read();
        const pendingTopics = [...new Set([...current.pendingTopics, ...failed])];
        await this.store.update({ pendingTopics });
        this.emit({ type: "topics", topics: pendingTopics });
        const reason = results.find((result) => result.status === "rejected");
        throw reason?.status === "rejected" ? reason.reason : new Error("Не удалось запустить часть тем");
      }
      await this.store.update({ lastConversationAt: new Date().toISOString() });
      return this.state();
    } finally {
      this.running = false;
      this.emit({ type: "runtime", running: false });
    }
  }

  private async startRemoteConversation(topic: string) {
    const stored = await this.store.read();
    if (!stored.identityConfigured) throw new Error("Сначала укажите, как вас называть");
    if (!stored.remote || !this.remote) throw new Error("Сначала соедините два приложения");
    if (stored.blockedTopics.some((blocked) => topic.toLowerCase().includes(blocked.toLowerCase()))) {
      throw new Error(`Тема заблокирована локальной политикой: ${topic}`);
    }
    const pair = await this.remote.pairState(stored.remote.pairId);
    const me = await this.remote.identity();
    const recipientId = pair.owner_id === me ? pair.partner_id : pair.owner_id;
    if (!recipientId) throw new Error("Второй участник ещё не подключился");
    const conversationId = randomUUID();
    const agent = this.localRemoteAgent(conversationId, stored.owner, stored.language, stored.displayName, stored.remote.peerName);
    const response = await agent.start(`Предложи второму семейному агенту обсудить тему: ${topic}`);
    this.remoteMessages.set(conversationId, [{ from: stored.owner, text: response.message_to_peer }]);
    await this.remote.send({ pairId: pair.id, conversationId, sequence: 1, recipientId, senderAgent: stored.owner,
      payload: { kind: "dialogue", text: response.message_to_peer, topic, status: response.status, sharedSummary: response.shared_summary, senderName: stored.displayName } satisfies DialoguePayload, idempotencyKey: `${conversationId}:1` });
    this.emit({ type: "message", from: stored.owner, to: stored.owner === "dima" ? "katya" : "dima", text: response.message_to_peer, turn: 1 });
  }

  private async shareTopic(topic: string) {
    const stored = await this.store.read();
    if (!stored.remote || !this.remote) return;
    const pair = await this.remote.pairState(stored.remote.pairId);
    await this.shareTopicToPair(topic, stored, pair);
  }

  private async shareTopicToPair(topic: string, stored: Awaited<ReturnType<AtomicStore["read"]>>, pair: Awaited<ReturnType<SupabaseTransport["pairState"]>>) {
    if (!this.remote) return;
    const me = await this.remote.identity();
    const recipientId = pair.owner_id === me ? pair.partner_id : pair.owner_id;
    if (!recipientId) return;
    const controlId = randomUUID();
    await this.remote.send({ pairId: pair.id, conversationId: controlId, sequence: 1, recipientId, senderAgent: stored.owner,
      payload: { kind: "topic", topic, senderName: stored.displayName } satisfies TopicPayload, idempotencyKey: `topic:${controlId}` });
  }

  private configureRemote(secret: string) {
    if (this.remoteTimer) clearInterval(this.remoteTimer);
    this.remote = new SupabaseTransport(BackgroundService.supabaseUrl, BackgroundService.supabaseKey, secret, this.authStorage());
    this.remoteTimer = setInterval(() => void this.pumpRemote(), 2_000);
    void this.pumpRemote();
    return this.remote;
  }

  private authStorage(): AuthStorage {
    const file = path.join(this.userData, "supabase-auth.json");
    const read = (): Record<string, string> => {
      try { return JSON.parse(readFileSync(file, "utf8")) as Record<string, string>; }
      catch { return {}; }
    };
    return {
      getItem: (key) => read()[key] ?? null,
      setItem: (key, value) => {
        const data = read();
        data[key] = value;
        writeFileSync(file, JSON.stringify(data), "utf8");
      },
      removeItem: (key) => {
        const data = read();
        delete data[key];
        if (Object.keys(data).length) writeFileSync(file, JSON.stringify(data), "utf8");
        else rmSync(file, { force: true });
      },
    };
  }

  private localRemoteAgent(conversationId: string, owner: OwnerId, language: AppLanguage, ownerName: string, peerName?: string) {
    const existing = this.remoteAgents.get(conversationId);
    if (existing) return existing;
    const schemaPath = path.join(this.resourcesPath, "schemas", "agent-response.schema.json");
    const memoryRoot = path.join(this.userData, "psychologist-memory");
    let memory = "Личная память ещё не синхронизирована.";
    let communicationExamples = "Примеры реплик из базового чата ещё не синхронизированы.";
    try {
      const files = [path.join(memoryRoot, "personal-profile.md")];
      const topics = path.join(memoryRoot, "topic-summaries");
      if (existsSync(topics)) files.push(...readdirSync(topics).filter((x) => x.endsWith(".md")).map((x) => path.join(topics, x)));
      memory = files.filter(existsSync).map((file) => readFileSync(file, "utf8")).join("\n\n").slice(0, 80_000) || memory;
      const examplesFile = path.join(memoryRoot, "style-samples.jsonl");
      if (existsSync(examplesFile)) communicationExamples = readFileSync(examplesFile, "utf8").slice(-30_000);
    } catch { /* optional */ }
    const agent = new CodexCliAgent({ id: owner, displayName: ownerName,
      ownerName, peerName: peerName || "Партнёр",
      perspective: `Используй локальную психологическую память как фон, не цитируя её дословно:\n${memory}`,
      language,
      communicationExamples,
      workspace: path.join(this.userData, "agents", owner, conversationId), schemaPath, codexCommand: defaultCodexCommand() });
    this.remoteAgents.set(conversationId, agent);
    return agent;
  }

  private async pumpRemote() {
    if (this.remoteBusy || !this.remote) return;
    this.remoteBusy = true;
    try {
      const stored = await this.store.read();
      if (!stored.remote) return;
      const pair = await this.remote.pairState(stored.remote.pairId);
      if (!pair.partner_id) return;
      const topicSyncKey = `${pair.id}:${pair.partner_id}`;
      if (this.syncedTopicsForPair !== topicSyncKey) {
        this.syncedTopicsForPair = topicSyncKey;
        for (const topic of stored.pendingTopics) await this.shareTopicToPair(topic, stored, pair);
      }
      const envelope = await this.remote.claimNext(stored.remote.pairId) as RemoteEnvelope<TopicPayload | DialoguePayload> | null;
      if (!envelope) return;
      if (!stored.identityConfigured) return;
      const peerName = envelope.payload.senderName?.trim() || stored.remote.peerName;
      if (peerName && peerName !== stored.remote.peerName) {
        await this.store.update({ remote: { ...stored.remote, peerName } });
        this.emit({ type: "peer", peerName });
      }
      if (envelope.payload.kind === "topic") {
        const current = await this.store.read();
        const blocked = current.blockedTopics.some((item) => envelope.payload.topic.toLowerCase().includes(item.toLowerCase()));
        if (!blocked && !current.pendingTopics.includes(envelope.payload.topic)) {
          const pendingTopics = [...current.pendingTopics, envelope.payload.topic];
          await this.store.update({ pendingTopics });
          this.emit({ type: "topics", topics: pendingTopics });
        }
        await this.remote.acknowledge(envelope.id);
        return;
      }
      const pendingTopics = stored.pendingTopics.filter((item) => item !== envelope.payload.topic);
      if (pendingTopics.length !== stored.pendingTopics.length) {
        await this.store.update({ pendingTopics });
        this.emit({ type: "topics", topics: pendingTopics });
      }
      const agent = this.localRemoteAgent(envelope.conversation_id, stored.owner, stored.language, stored.displayName, peerName);
      const isFirst = !this.remoteMessages.has(envelope.conversation_id);
      const response = isFirst ? await agent.start(envelope.payload.text) : await agent.respond(envelope.payload.text);
      const messages = this.remoteMessages.get(envelope.conversation_id) ?? [];
      messages.push({ from: envelope.sender_agent as "dima" | "katya", text: envelope.payload.text }, { from: stored.owner, text: response.message_to_peer });
      this.remoteMessages.set(envelope.conversation_id, messages);
      this.emit({ type: "message", from: envelope.sender_agent as "dima" | "katya", to: stored.owner, text: envelope.payload.text, turn: envelope.sequence_number });
      if (envelope.payload.status !== "complete" && envelope.sequence_number < 8) {
        const me = await this.remote.identity();
        const recipientId = pair.owner_id === me ? pair.partner_id! : pair.owner_id;
        const sequence = envelope.sequence_number + 1;
        await this.remote.send({ pairId: pair.id, conversationId: envelope.conversation_id, sequence, recipientId, senderAgent: stored.owner,
          payload: { kind: "dialogue", text: response.message_to_peer, topic: envelope.payload.topic, status: response.status, sharedSummary: response.shared_summary, senderName: stored.displayName } satisfies DialoguePayload, idempotencyKey: `${envelope.conversation_id}:${sequence}` });
        await this.remote.acknowledge(envelope.id);
        this.emit({ type: "message", from: stored.owner, to: stored.owner === "dima" ? "katya" : "dima", text: response.message_to_peer, turn: sequence });
        if (response.status === "complete") await this.saveRemoteReport(envelope.conversation_id, envelope.payload.topic, response.shared_summary, messages);
      } else {
        await this.remote.acknowledge(envelope.id);
        await this.saveRemoteReport(envelope.conversation_id, envelope.payload.topic, response.shared_summary, messages);
      }
    } catch (error) { this.emit({ type: "error", error: error instanceof Error ? error.message : String(error) }); }
    finally { this.remoteBusy = false; }
  }

  private async saveRemoteReport(conversationId: string, topic: string, summary: string, messages: Array<{ from: string; text: string }>) {
    const reportsDir = path.join(this.userData, "reports");
    await mkdir(reportsDir, { recursive: true });
    const reportPath = path.join(reportsDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-remote.json`);
    await writeFile(reportPath, JSON.stringify({ conversationId, topic, sharedSummary: summary, messages, completedAt: new Date().toISOString() }, null, 2));
    const state = await this.store.read();
    const pendingTopics = state.pendingTopics.filter((item) => item !== topic);
    await this.store.update({ reports: [reportPath, ...state.reports].slice(0, 100), pendingTopics, lastConversationAt: new Date().toISOString() });
    this.emit({ type: "topics", topics: pendingTopics });
    this.emit({ type: "status", status: "completed" });
  }

  async addTopic(topic: string) {
    const trimmed = topic.trim();
    if (!trimmed) return this.state();
    const state = await this.store.read();
    if (!state.pendingTopics.includes(trimmed)) state.pendingTopics.push(trimmed);
    await this.store.update({ pendingTopics: state.pendingTopics });
    this.emit({ type: "topics", topics: state.pendingTopics });
    try { await this.shareTopic(trimmed); }
    catch (error) { this.emit({ type: "error", error: error instanceof Error ? error.message : String(error) }); }
    return this.state();
  }

  async blockTopic(topic: string) {
    const trimmed = topic.trim();
    if (!trimmed) return this.state();
    const state = await this.store.read();
    if (!state.blockedTopics.includes(trimmed)) state.blockedTopics.push(trimmed);
    await this.store.update({ blockedTopics: state.blockedTopics });
    return this.state();
  }

  async run(topic: string, realCodex: boolean): Promise<ConversationReport> {
    if (this.running) throw new Error("Разговор уже выполняется");
    const state = await this.store.read();
    if (state.blockedTopics.some((blocked) => topic.toLowerCase().includes(blocked.toLowerCase()))) {
      throw new Error("Тема заблокирована локальной политикой");
    }
    this.running = true;
    this.emit({ type: "status", status: "agenda_negotiation" });
    try {
      const [dima, katya] = realCodex ? this.codexAgents(state.language) : this.mockAgents(state.language);
      const coordinator = new ConversationCoordinator(dima, katya, undefined, {
        maxTurns: 8,
        onEvent: (event) => this.emit(event),
      });
      const report = await coordinator.run(topic);
      const reportsDir = path.join(this.userData, "reports");
      await mkdir(reportsDir, { recursive: true });
      const reportPath = path.join(reportsDir, `${report.completedAt.replace(/[:.]/g, "-")}.json`);
      await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
      await this.store.update({
        reports: [reportPath, ...state.reports].slice(0, 100),
        pendingTopics: state.pendingTopics.filter((item) => item !== topic),
        lastConversationAt: report.completedAt,
      });
      return report;
    } finally {
      this.running = false;
      this.emit({ type: "runtime", running: false });
    }
  }

  private emit(event: CoordinatorEvent | { type: "runtime"; running: boolean } | { type: "peer"; peerName: string } | { type: "context"; context: ContextSource } | { type: "context-analysis"; analysis: ContextAnalysis } | { type: "topics"; topics: string[] }) {
    this.windowProvider()?.webContents.send("bridge:event", event);
  }

  private async codexStatus() {
    try {
      const command = defaultCodexCommand();
      const version = await execFileAsync(command, ["--version"], { timeout: 10_000 });
      const login = await execFileAsync(command, ["login", "status"], { timeout: 10_000 });
      return {
        installed: true,
        authenticated: /logged in using chatgpt/i.test(login.stdout + login.stderr),
        version: (version.stdout || version.stderr).trim(),
      };
    } catch {
      return { installed: false, authenticated: false, version: "" };
    }
  }

  private codexAgents(language: AppLanguage): [AgentRuntime, AgentRuntime] {
    const schemaPath = path.join(this.resourcesPath, "schemas", "agent-response.schema.json");
    const root = path.join(this.userData, "agents");
    const command = defaultCodexCommand();
    return [
      new CodexCliAgent({
        id: "dima",
        displayName: "Димы",
        perspective: "Demo: владельцу важна предсказуемость и ясность ключевых договорённостей.",
        language,
        workspace: path.join(root, "dima"),
        schemaPath,
        codexCommand: command,
      }),
      new CodexCliAgent({
        id: "katya",
        displayName: "Кати",
        perspective: "Demo: владельцу важны гибкость и свобода менять необязательные планы.",
        language,
        workspace: path.join(root, "katya"),
        schemaPath,
        codexCommand: command,
      }),
    ];
  }

  private mockAgents(language: AppLanguage): [AgentRuntime, AgentRuntime] {
    const make = (
      message_to_peer: string,
      status: AgentResponse["status"],
      private_report = "",
      shared_summary = "",
    ): AgentResponse => ({
      message_to_peer,
      status,
      topics: ["ручная тема"],
      private_report,
      shared_summary,
    });
    const dialogue = {
      ru: [
        "Предлагаю определить одну общую цель и по одному важному условию каждой стороны. Что для вашей стороны важнее всего?",
        "Вижу совместимую основу. Предлагаю проверить договорённость две недели и затем оценить результат.",
        "Для нашей стороны важно сохранить возможность корректировки. Готовы согласовать минимальное обязательное условие.",
        "Согласны на ограниченный эксперимент с возможностью пересмотра без взаимных обвинений.",
        "Сформулирована конкретная просьба без обвинения.", "Удалось сохранить гибкость и договориться о проверке.",
        "Стороны выбрали небольшой двухнедельный эксперимент и договорились оценить его результат.",
      ],
      en: [
        "Let's define one shared goal and one important condition for each side. What matters most to your side?",
        "I see compatible ground. Let's test the agreement for two weeks and then evaluate the result.",
        "It is important for our side to keep room for adjustment. We can agree on a minimum commitment.",
        "We agree to a limited experiment that can be reviewed without mutual blame.",
        "A specific request was made without blame.", "We preserved flexibility and agreed on a review.",
        "Both sides chose a small two-week experiment and agreed to evaluate its result.",
      ],
      cs: [
        "Navrhuji stanovit jeden společný cíl a jednu důležitou podmínku pro každou stranu. Co je pro vaši stranu nejdůležitější?",
        "Vidím společný základ. Navrhuji dohodu vyzkoušet dva týdny a potom vyhodnotit výsledek.",
        "Pro naši stranu je důležité zachovat možnost úprav. Můžeme se dohodnout na minimálním závazku.",
        "Souhlasíme s omezeným pokusem, který lze přehodnotit bez vzájemného obviňování.",
        "Konkrétní žádost byla formulována bez obviňování.", "Zachovali jsme flexibilitu a dohodli kontrolu výsledku.",
        "Obě strany zvolily malý dvoutýdenní pokus a dohodly se na vyhodnocení výsledku.",
      ],
      fr: [
        "Je propose de définir un objectif commun et une condition importante pour chaque partie. Qu'est-ce qui compte le plus pour vous ?",
        "Je vois une base compatible. Essayons cet accord pendant deux semaines, puis évaluons le résultat.",
        "Il est important pour nous de conserver une possibilité d'ajustement. Nous pouvons convenir d'un engagement minimal.",
        "Nous acceptons une expérience limitée, révisable sans reproches mutuels.",
        "Une demande concrète a été formulée sans reproche.", "Nous avons préservé la souplesse et convenu d'un bilan.",
        "Les deux parties ont choisi une petite expérience de deux semaines et convenu d'en évaluer le résultat.",
      ],
    }[language];
    return [
      new MockAgent("dima", [
        make(dialogue[0], "continue"),
        make(dialogue[1], "complete", dialogue[4], dialogue[6]),
      ]),
      new MockAgent("katya", [
        make(dialogue[2], "continue"),
        make(dialogue[3], "complete", dialogue[5], dialogue[6]),
      ]),
    ];
  }
}
