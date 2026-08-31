import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import net from "node:net";
import type { ContextMessage, ContextThread } from "./codex-history.js";

type JsonObject = Record<string, unknown>;

const pipeRoot = "\\\\.\\pipe\\";
const maxFrameBytes = 8 * 1024 * 1024;

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

class NativePipeClient {
  private socket?: net.Socket;
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<number, { resolve: (value: JsonObject) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  constructor(private readonly pipePath: string) {}

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
    this.socket?.destroy();
    this.socket = undefined;
  }

  request(method: string, params?: JsonObject): Promise<JsonObject> {
    if (!this.socket) return Promise.reject(new Error("Codex Desktop pipe is not connected"));
    const id = this.nextId++;
    const payload = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }), "utf8");
    if (payload.length > maxFrameBytes) return Promise.reject(new Error("Codex Desktop request is too large"));
    const frame = Buffer.alloc(4 + payload.length);
    frame.writeUInt32LE(payload.length, 0);
    payload.copy(frame, 4);
    return new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex Desktop timed out while running ${method}`));
      }, 60_000);
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
        const response = JSON.parse(payload.toString("utf8")) as { id?: number; result?: JsonObject; error?: { message?: string } };
        if (typeof response.id !== "number") continue;
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

export class CodexAppHistoryClient {
  constructor(private readonly callingThreadId: string) {}

  async listThreads(): Promise<ContextThread[]> {
    return this.withClient(async (client) => {
      const [threads, projects] = await Promise.all([
        this.callTool(client, "list_threads", { limit: 50 }),
        this.callTool(client, "list_projects", {}),
      ]);
      return parseChatGptThreads(threads, projects);
    });
  }

  async readUserMessages(threadId: string): Promise<ContextMessage[]> {
    return this.withClient(async (client) => {
      const pages: unknown[] = [];
      let cursor: string | undefined;
      do {
        const page = await this.callTool(client, "read_thread", {
          threadId,
          turnLimit: 10,
          includeOutputs: false,
          maxOutputCharsPerItem: 20_000,
          ...(cursor ? { cursor } : {}),
        });
        pages.push(page);
        const paging = object(object(page).page);
        cursor = paging.hasMore === true && typeof paging.nextCursor === "string" ? paging.nextCursor : undefined;
      } while (cursor);
      return extractChatGptUserMessages(pages);
    });
  }

  private async withClient<T>(operation: (client: NativePipeClient) => Promise<T>): Promise<T> {
    let lastError: Error | undefined;
    const pipes = readdirSync(pipeRoot).filter((name) => name.startsWith("codex-browser-use-"));
    for (const pipe of pipes) {
      const client = new NativePipeClient(`${pipeRoot}${pipe}`);
      try {
        await client.connect();
        const listed = object(await client.request("tools/list", { threadStartKind: "all" }));
        const names = values(listed.tools).map((tool) => tool.name);
        if (!names.includes("list_threads") || !names.includes("read_thread") || !names.includes("list_projects")) throw new Error("Required Codex Desktop tools are unavailable");
        const result = await operation(client);
        client.close();
        return result;
      } catch (error) {
        client.close();
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    throw new Error(`Не удалось прочитать чаты ChatGPT через Codex Desktop. Откройте Codex и попробуйте снова.${lastError ? ` ${lastError.message}` : ""}`);
  }

  private async callTool(client: NativePipeClient, tool: string, args: JsonObject): Promise<unknown> {
    const result = object(await client.request("tools/call", {
      arguments: args,
      callId: randomUUID(),
      namespace: "codex_app",
      threadId: this.callingThreadId,
      tool,
      turnId: randomUUID(),
    }));
    if (result.success !== true) throw new Error(`Codex Desktop could not run ${tool}`);
    const text = values(result.contentItems).find((item) => item.type === "inputText" && typeof item.text === "string")?.text;
    if (typeof text !== "string") throw new Error(`Codex Desktop returned no data for ${tool}`);
    return JSON.parse(text) as unknown;
  }
}
