import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import type { ContextMessage, ContextThread } from "./codex-history.js";

type JsonObject = Record<string, unknown>;

const windowsPipeRoot = "\\\\.\\pipe\\";
const unixSocketRoot = "/tmp/codex-browser-use";
const maxFrameBytes = 8 * 1024 * 1024;

export function resolveCodexAppTransportCandidates(
  entries: string[],
  platform: NodeJS.Platform = process.platform,
  root = platform === "win32" ? windowsPipeRoot : unixSocketRoot,
): string[] {
  if (platform === "win32") {
    return entries
      .filter((name) => name.startsWith("codex-browser-use-"))
      .map((name) => `${root}${name}`);
  }
  return entries
    .filter((name) => name.endsWith(".sock"))
    .map((name) => path.posix.join(root, name));
}

export function listCodexAppTransportCandidates(platform: NodeJS.Platform = process.platform): string[] {
  const root = platform === "win32" ? windowsPipeRoot : unixSocketRoot;
  try {
    return resolveCodexAppTransportCandidates(readdirSync(root), platform, root);
  } catch {
    return [];
  }
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" ? value as JsonObject : {};
}

function values(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.map(object) : [];
}

export function parseChatGptThreads(threadsResult: unknown, projectsResult: unknown): ContextThread[] {
  const projectLabels = new Map<string, string>();
  for (const project of values(object(projectsResult).projects)) {
    const projectId = typeof project.projectId === "string" ? project.projectId : typeof project.id === "string" ? project.id : undefined;
    if (projectId) {
      const label = typeof project.label === "string" && project.label.trim() ? project.label.trim() : "ChatGPT";
      projectLabels.set(projectId, label);
    }
  }
  const root = object(threadsResult);
  const entries = [...values(root.pinnedThreads), ...values(root.threads)];
  const seen = new Set<string>();
  return entries.flatMap((entry): ContextThread[] => {
    if (entry.kind !== "chatgpt" || typeof entry.id !== "string" || seen.has(entry.id)) return [];
    seen.add(entry.id);
    const projectId = typeof entry.projectId === "string" ? entry.projectId : undefined;
    const title = typeof entry.title === "string" && entry.title.trim() ? entry.title.trim() : "Без названия";
    return [{
      id: entry.id,
      title,
      project: projectId ? projectLabels.get(projectId) ?? "ChatGPT" : "ChatGPT",
      source: "chatgpt",
      updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : undefined,
    }];
  });
}

export function extractChatGptUserMessages(pages: unknown[]): ContextMessage[] {
  const turns = pages.flatMap((page) => values(object(page).turns));
  turns.sort((left, right) => Number(left.startedAt ?? 0) - Number(right.startedAt ?? 0));
  const messages: ContextMessage[] = [];
  for (const turn of turns) {
    for (const item of values(turn.items)) {
      if (item.type !== "userMessage") continue;
      const text = values(item.content)
        .map((part) => part.type === "text" && typeof part.text === "string" ? part.text : "")
        .filter(Boolean)
        .join("\n")
        .trim();
      if (!text) continue;
      messages.push({
        message_id: typeof item.id === "string" ? item.id : `${String(turn.id ?? "turn")}:${messages.length}`,
        created_at: typeof turn.startedAt === "number" ? new Date(turn.startedAt * 1000).toISOString() : undefined,
        text,
      });
    }
  }
  return messages;
}

export class NativePipeClient {
  private socket?: net.Socket;
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<string, { resolve: (value: JsonObject) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  constructor(private readonly pipePath: string, private readonly requestTimeoutMs = 60_000) {}

  async connect(timeoutMs = 1_500) {
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(this.pipePath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("Codex Desktop pipe timed out"));
      }, timeoutMs);
      socket.once("error", (error) => { clearTimeout(timer); reject(error); });
      socket.once("connect", () => {
        clearTimeout(timer);
        this.socket = socket;
        socket.on("data", (chunk) => this.onData(chunk));
        socket.on("error", (error) => this.fail(error));
        socket.on("close", () => this.fail(new Error("Codex Desktop pipe closed")));
        resolve();
      });
    });
  }

  close() {
    for (const id of this.pending.keys()) this.cancel(id);
    this.fail(new CodexAppHistoryError("CODEX_DESKTOP_UNAVAILABLE"));
    this.socket?.end();
    this.socket = undefined;
  }

  private cancel(id: string) {
    if (!this.socket || this.socket.destroyed) return;
    const payload = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/cancel" }));
    const frame = Buffer.alloc(4 + payload.length); frame.writeUInt32LE(payload.length); payload.copy(frame, 4);
    this.socket.write(frame);
  }

  request(method: string, params?: JsonObject): Promise<JsonObject> {
    if (!this.socket) return Promise.reject(new Error("Codex Desktop pipe is not connected"));
    const id = randomUUID();
    const payload = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }), "utf8");
    if (payload.length > maxFrameBytes) return Promise.reject(new Error("Codex Desktop request is too large"));
    const frame = Buffer.alloc(4 + payload.length);
    frame.writeUInt32LE(payload.length, 0);
    payload.copy(frame, 4);
    return new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.cancel(id);
        this.pending.delete(id);
        reject(new CodexAppHistoryError("CODEX_DESKTOP_TIMEOUT"));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.write(frame, (error) => {
        if (!error) return;
        const waiting = this.pending.get(id);
        if (waiting) clearTimeout(waiting.timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private onData(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > maxFrameBytes) { this.fail(new Error("Codex Desktop response is too large")); return; }
      if (this.buffer.length < length + 4) return;
      const payload = this.buffer.subarray(4, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      try {
        const response = JSON.parse(payload.toString("utf8")) as { id?: string; result?: JsonObject; error?: { message?: string } };
        if (typeof response.id !== "string") continue;
        const waiting = this.pending.get(response.id);
        if (!waiting) continue;
        this.pending.delete(response.id);
        clearTimeout(waiting.timer);
        if (response.error) waiting.reject(new Error(response.error.message ?? "Codex Desktop request failed"));
        else waiting.resolve(response.result ?? {});
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private fail(error: Error) {
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(error);
    }
    this.pending.clear();
    this.buffer = Buffer.alloc(0);
  }
}

export class CodexAppHistoryError extends Error {
  constructor(readonly code: "CODEX_DESKTOP_UNAVAILABLE" | "CODEX_DESKTOP_BUSY" | "CODEX_DESKTOP_TIMEOUT" | "CODEX_DESKTOP_PROTOCOL" | "CODEX_HISTORY_READ_FAILED" | "CHATGPT_SOURCE_UNAVAILABLE") {
    super({
      CODEX_DESKTOP_UNAVAILABLE: "Подключение к Codex Desktop для чтения чата сейчас недоступно. Сохранённый контекст остаётся на месте.",
      CODEX_DESKTOP_BUSY: "Codex временно перегружен запросами. Не удалось завершить чтение чата; сохранённый контекст остаётся на месте.",
      CODEX_DESKTOP_TIMEOUT: "Codex не завершил чтение чата вовремя. Сохранённый контекст остаётся на месте.",
      CODEX_DESKTOP_PROTOCOL: "Не удалось согласовать формат чтения чата с Codex Desktop. Сохранённый контекст остаётся на месте.",
      CODEX_HISTORY_READ_FAILED: "Codex не смог прочитать выбранный чат. Сохранённый контекст остаётся на месте.",
      CHATGPT_SOURCE_UNAVAILABLE: "Codex Desktop временно не может получить чаты ChatGPT. Сохранённый контекст остаётся на месте.",
    }[code]);
  }
}

interface AppHistoryOptions {
  transports?: () => string[];
  pause?: (ms: number) => Promise<void>;
  onDiagnostic?: (code: string) => void;
  onPage?: (pages: number) => void;
}

export class CodexAppHistoryClient {
  constructor(private readonly callingThreadId: string, private readonly options: AppHistoryOptions = {}) {}

  async listThreads(): Promise<ContextThread[]> {
    return this.withClient(async (client) => {
      const threads = await this.callTool(client, "list_threads", { limit: 50 });
      if (values(object(threads).unavailableSources).some(source => JSON.stringify(source).toLowerCase().includes("chatgpt"))) throw new CodexAppHistoryError("CHATGPT_SOURCE_UNAVAILABLE");
      const projects = await this.callTool(client, "list_projects", {});
      return parseChatGptThreads(threads, projects);
    });
  }

  async readUserMessages(threadId: string): Promise<ContextMessage[]> {
    return this.withClient(async (client) => {
      const pages: unknown[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const page = await this.callTool(client, "read_thread", {
          threadId,
          turnLimit: 10,
          includeOutputs: false,
          maxOutputCharsPerItem: 20_000,
          ...(cursor ? { cursor } : {}),
        });
        if (!Array.isArray(object(page).turns) || typeof object(object(page).page).hasMore !== "boolean") throw new CodexAppHistoryError("CODEX_DESKTOP_PROTOCOL");
        pages.push(page);
        this.options.onPage?.(pages.length);
        const paging = object(object(page).page);
        if (paging.hasMore === true && (typeof paging.nextCursor !== "string" || !paging.nextCursor)) throw new CodexAppHistoryError("CODEX_DESKTOP_PROTOCOL");
        cursor = paging.hasMore === true ? paging.nextCursor as string : undefined;
        if (cursor && seen.has(cursor)) throw new CodexAppHistoryError("CODEX_DESKTOP_PROTOCOL");
        if (cursor) seen.add(cursor);
      } while (cursor);
      return extractChatGptUserMessages(pages);
    });
  }

  private async withClient<T>(operation: (client: NativePipeClient) => Promise<T>): Promise<T> {
    const discovered = (this.options.transports ?? listCodexAppTransportCandidates)();
    const preferred = process.env.CODEX_APP_TOOLS_PIPE_PATH;
    const transports = [...new Set([...(preferred && discovered.includes(preferred) ? [preferred] : []), ...discovered])];
    for (const transport of transports) {
      const client = new NativePipeClient(transport);
      try {
        await client.connect();
        const listed = object(await client.request("tools/list", { threadStartKind: "all" }));
        const names = values(listed.tools).filter(tool => !tool.namespace || tool.namespace === "codex_app").map(tool => tool.name);
        if (!["list_threads", "read_thread", "list_projects"].every(name => names.includes(name))) { client.close(); continue; }
      } catch { client.close(); continue; }
      // Once capabilities match, a reading failure belongs to this application.
      // Browser endpoints with similar pipe names must not replace its cause.
      try { return await operation(client); }
      finally { client.close(); }
    }
    throw new CodexAppHistoryError("CODEX_DESKTOP_UNAVAILABLE");
  }

  private async callTool(client: NativePipeClient, tool: string, args: JsonObject): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        const result = object(await client.request("tools/call", {
          arguments: args, callId: randomUUID(), namespace: "codex_app",
          threadId: this.callingThreadId, tool, turnId: randomUUID(),
        }));
        const text = values(result.contentItems).find(item => item.type === "inputText" && typeof item.text === "string")?.text;
        if (result.success !== true) {
          const busy = typeof text === "string" && /too many concurrent requests|concurrency limit|rate.?limit|overloaded|429/i.test(text);
          throw new CodexAppHistoryError(busy ? "CODEX_DESKTOP_BUSY" : "CODEX_HISTORY_READ_FAILED");
        }
        if (typeof text !== "string") throw new CodexAppHistoryError("CODEX_DESKTOP_PROTOCOL");
        try { return JSON.parse(text) as unknown; }
        catch { throw new CodexAppHistoryError("CODEX_DESKTOP_PROTOCOL"); }
      } catch (error) {
        const failure = error instanceof CodexAppHistoryError ? error : new CodexAppHistoryError("CODEX_HISTORY_READ_FAILED");
        this.options.onDiagnostic?.(failure.code);
        if (attempt >= 3 || !["CODEX_DESKTOP_BUSY", "CODEX_DESKTOP_TIMEOUT"].includes(failure.code)) throw failure;
        await (this.options.pause ?? delay)([2000, 5000, 10000][attempt]);
      }
    }
  }
}
