import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import type { BrowserWindow } from "electron";
import { CodexCliAgent, defaultCodexCommand } from "../src/core/codex-runtime.js";
import { ConversationCoordinator, type CoordinatorEvent } from "../src/core/coordinator.js";
import { MockAgent } from "../src/core/mock-runtime.js";
import { SupabaseTransport, type PairingInvite, type RemoteEnvelope } from "../src/core/supabase-transport.js";
import type { AgentResponse, AgentRuntime, ConversationReport } from "../src/core/types.js";
import { AtomicStore } from "./store.js";

const execFileAsync = promisify(execFile);

export class BackgroundService {
  private running = false;
  private remote?: SupabaseTransport;
  private remoteTimer?: NodeJS.Timeout;
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
      encryptionSecret: stored.remote.encryptionSecret,
    })).toString("base64url") : undefined;
    return { ...stored, codex, running: this.running, remote: { configured: Boolean(stored.remote), connected, pairId: stored.remote?.pairId, invite } };
  }

  async start() {
    const state = await this.store.read();
    if (state.remote) this.configureRemote(state.remote.encryptionSecret);
  }

  async createPair() {
    const transport = this.configureRemote("");
    const invite = await transport.createPair();
    await this.store.update({ remote: { pairId: invite.pairId, encryptionSecret: invite.encryptionSecret, inviteSecret: invite.inviteSecret } });
    this.configureRemote(invite.encryptionSecret);
    return this.state();
  }

  async joinPair(encoded: string) {
    const invite = JSON.parse(Buffer.from(encoded.trim(), "base64url").toString("utf8")) as PairingInvite;
    const transport = this.configureRemote(invite.encryptionSecret);
    await transport.joinPair(invite);
    await this.store.update({ remote: { pairId: invite.pairId, encryptionSecret: invite.encryptionSecret } });
    return this.state();
  }

  async runRemote(topic: string) {
    const stored = await this.store.read();
    if (!stored.remote || !this.remote) throw new Error("Сначала соедините два приложения");
    const pair = await this.remote.pairState(stored.remote.pairId);
    const me = await this.remote.identity();
    const recipientId = pair.owner_id === me ? pair.partner_id : pair.owner_id;
    if (!recipientId) throw new Error("Второй участник ещё не подключился");
    const conversationId = randomUUID();
    const agent = this.localRemoteAgent(conversationId, stored.owner);
    const response = await agent.start(`Предложи второму семейному агенту обсудить тему: ${topic}`);
    this.remoteMessages.set(conversationId, [{ from: stored.owner, text: response.message_to_peer }]);
    await this.remote.send({ pairId: pair.id, conversationId, sequence: 1, recipientId, senderAgent: stored.owner,
      payload: { text: response.message_to_peer, topic, status: response.status, sharedSummary: response.shared_summary }, idempotencyKey: `${conversationId}:1` });
    this.emit({ type: "message", from: stored.owner, to: stored.owner === "dima" ? "katya" : "dima", text: response.message_to_peer, turn: 1 });
  }

  private configureRemote(secret: string) {
    if (this.remoteTimer) clearInterval(this.remoteTimer);
    this.remote = new SupabaseTransport(BackgroundService.supabaseUrl, BackgroundService.supabaseKey, secret);
    this.remoteTimer = setInterval(() => void this.pumpRemote(), 2_000);
    void this.pumpRemote();
    return this.remote;
  }

  private localRemoteAgent(conversationId: string, owner: "dima" | "katya") {
    const existing = this.remoteAgents.get(conversationId);
    if (existing) return existing;
    const schemaPath = path.join(this.resourcesPath, "schemas", "agent-response.schema.json");
    const memoryPath = path.join(this.userData, "psychologist-memory", "MEMORY.md");
    let memory = "Личная память ещё не синхронизирована.";
    try { memory = readFileSync(memoryPath, "utf8").slice(0, 80_000); } catch { /* optional */ }
    const agent = new CodexCliAgent({ id: owner, displayName: owner === "dima" ? "Димы" : "Кати",
      perspective: `Используй локальную психологическую память как фон, не цитируя её дословно:\n${memory}`,
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
      const envelope = await this.remote.claimNext(stored.remote.pairId) as RemoteEnvelope<{ text: string; topic: string; status: string; sharedSummary?: string }> | null;
      if (!envelope) return;
      const agent = this.localRemoteAgent(envelope.conversation_id, stored.owner);
      const isFirst = !this.remoteMessages.has(envelope.conversation_id);
      const response = isFirst ? await agent.start(envelope.payload.text) : await agent.respond(envelope.payload.text);
      const messages = this.remoteMessages.get(envelope.conversation_id) ?? [];
      messages.push({ from: envelope.sender_agent as "dima" | "katya", text: envelope.payload.text }, { from: stored.owner, text: response.message_to_peer });
      this.remoteMessages.set(envelope.conversation_id, messages);
      this.emit({ type: "message", from: envelope.sender_agent as "dima" | "katya", to: stored.owner, text: envelope.payload.text, turn: envelope.sequence_number });
      await this.remote.acknowledge(envelope.id);
      if (response.status !== "complete" && envelope.sequence_number < 8) {
        const me = await this.remote.identity();
        const recipientId = pair.owner_id === me ? pair.partner_id! : pair.owner_id;
        const sequence = envelope.sequence_number + 1;
        await this.remote.send({ pairId: pair.id, conversationId: envelope.conversation_id, sequence, recipientId, senderAgent: stored.owner,
          payload: { text: response.message_to_peer, topic: envelope.payload.topic, status: response.status, sharedSummary: response.shared_summary }, idempotencyKey: `${envelope.conversation_id}:${sequence}` });
        this.emit({ type: "message", from: stored.owner, to: stored.owner === "dima" ? "katya" : "dima", text: response.message_to_peer, turn: sequence });
      } else {
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
    await this.store.update({ reports: [reportPath, ...state.reports].slice(0, 100), lastConversationAt: new Date().toISOString() });
    this.emit({ type: "status", status: "completed" });
  }

  async addTopic(topic: string) {
    const trimmed = topic.trim();
    if (!trimmed) return this.state();
    const state = await this.store.read();
    if (!state.pendingTopics.includes(trimmed)) state.pendingTopics.push(trimmed);
    await this.store.update({ pendingTopics: state.pendingTopics });
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
      const [dima, katya] = realCodex ? this.codexAgents() : this.mockAgents();
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

  private emit(event: CoordinatorEvent | { type: "runtime"; running: boolean }) {
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

  private codexAgents(): [AgentRuntime, AgentRuntime] {
    const schemaPath = path.join(this.resourcesPath, "schemas", "agent-response.schema.json");
    const root = path.join(this.userData, "agents");
    const command = defaultCodexCommand();
    return [
      new CodexCliAgent({
        id: "dima",
        displayName: "Димы",
        perspective: "Demo: владельцу важна предсказуемость и ясность ключевых договорённостей.",
        workspace: path.join(root, "dima"),
        schemaPath,
        codexCommand: command,
      }),
      new CodexCliAgent({
        id: "katya",
        displayName: "Кати",
        perspective: "Demo: владельцу важны гибкость и свобода менять необязательные планы.",
        workspace: path.join(root, "katya"),
        schemaPath,
        codexCommand: command,
      }),
    ];
  }

  private mockAgents(): [AgentRuntime, AgentRuntime] {
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
    return [
      new MockAgent("dima", [
        make("Предлагаю определить одну общую цель и по одному важному условию каждой стороны. Что для вашей стороны важнее всего?", "continue"),
        make("Вижу совместимую основу. Предлагаю проверить договорённость две недели и затем оценить результат.", "complete", "Сформулирована конкретная просьба без обвинения.", "Стороны выбрали небольшой двухнедельный эксперимент и договорились оценить его результат."),
      ]),
      new MockAgent("katya", [
        make("Для нашей стороны важно сохранить возможность корректировки. Готовы согласовать минимальное обязательное условие.", "continue"),
        make("Согласны на ограниченный эксперимент с возможностью пересмотра без взаимных обвинений.", "complete", "Удалось сохранить гибкость и договориться о проверке.", "Стороны выбрали небольшой двухнедельный эксперимент и договорились оценить его результат."),
      ]),
    ];
  }
}
