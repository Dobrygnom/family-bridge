import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

export interface ContextThread {
  id: string;
  title: string;
  project: string;
  source: "codex" | "chatgpt";
  cwd?: string;
  updatedAt?: number;
}

export interface ContextMessage {
  message_id: string;
  created_at?: string;
  text: string;
}

type JsonObject = Record<string, unknown>;

export function extractUserMessages(thread: JsonObject): ContextMessage[] {
  const result: ContextMessage[] = [];
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  for (const turnValue of turns) {
    const turn = turnValue && typeof turnValue === "object" ? turnValue as JsonObject : {};
    const items = Array.isArray(turn.items) ? turn.items : [];
    for (const itemValue of items) {
      const item = itemValue && typeof itemValue === "object" ? itemValue as JsonObject : {};
      if (item.type !== "userMessage") continue;
      const content = Array.isArray(item.content) ? item.content : [];
      const text = content
        .map((part) => part && typeof part === "object" && (part as JsonObject).type === "text" ? (part as JsonObject).text : "")
        .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
        .join("\n")
        .trim();
      if (!text) continue;
      result.push({
        message_id: typeof item.id === "string" ? item.id : `${String(turn.id ?? "turn")}:${result.length}`,
        created_at: typeof turn.createdAt === "number" ? new Date(turn.createdAt * 1000).toISOString() : undefined,
        text,
      });
    }
  }
  return result;
}

export class CodexHistoryClient {
  constructor(private readonly command: string) {}

  async listThreads(): Promise<ContextThread[]> {
    return this.withServer(async (request) => {
      const threads: ContextThread[] = [];
      let cursor: string | null = null;
      do {
        const result = await request("thread/list", { cursor, limit: 100, sortKey: "updated_at", sortDirection: "desc" });
        const data = Array.isArray(result.data) ? result.data : [];
        for (const value of data) {
          const item = value && typeof value === "object" ? value as JsonObject : {};
          if (typeof item.id !== "string") continue;
          const cwd = typeof item.cwd === "string" ? item.cwd : undefined;
          const title = typeof item.name === "string" && item.name.trim()
            ? item.name.trim()
            : typeof item.preview === "string" && item.preview.trim()
              ? item.preview.trim().split(/\r?\n/, 1)[0].slice(0, 100)
              : "Без названия";
          threads.push({ id: item.id, title, project: cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd : "Без проекта", source: "codex", cwd,
            updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : undefined });
        }
        cursor = typeof result.nextCursor === "string" ? result.nextCursor : null;
      } while (cursor);
      return threads;
    });
  }

  async readUserMessages(threadId: string): Promise<ContextMessage[]> {
    return this.withServer(async (request) => {
      const result = await request("thread/read", { threadId, includeTurns: true });
      const thread = result.thread && typeof result.thread === "object" ? result.thread as JsonObject : {};
      return extractUserMessages(thread);
    });
  }

  private async withServer<T>(operation: (request: (method: string, params?: JsonObject) => Promise<JsonObject>) => Promise<T>): Promise<T> {
    const child = spawn(this.command, ["app-server"], {
      shell: process.platform === "win32" && this.command.toLowerCase().endsWith(".cmd"),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    const lines = readline.createInterface({ input: child.stdout });
    let nextId = 1;
    let stderr = "";
    let processError: Error | undefined;
    const pending = new Map<number, { resolve: (value: JsonObject) => void; reject: (reason: Error) => void }>();
    const rejectPending = (error: Error) => {
      for (const waiting of pending.values()) waiting.reject(error);
      pending.clear();
    };
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-8_000); });
    child.once("error", (error) => {
      processError = error;
      rejectPending(error);
    });
    lines.on("line", (line) => {
      try {
        const message = JSON.parse(line) as { id?: number; result?: JsonObject; error?: { message?: string } };
        if (typeof message.id !== "number") return;
        const waiting = pending.get(message.id);
        if (!waiting) return;
        pending.delete(message.id);
        if (message.error) waiting.reject(new Error(message.error.message ?? "Codex app-server error"));
        else waiting.resolve(message.result ?? {});
      } catch { /* ignore non-protocol output */ }
    });
    const request = (method: string, params: JsonObject = {}) => new Promise<JsonObject>((resolve, reject) => {
      if (processError) {
        reject(processError);
        return;
      }
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ method, id, params })}\n`, (error) => {
        if (!error) return;
        const waiting = pending.get(id);
        pending.delete(id);
        waiting?.reject(error);
      });
    });
    const timeout = setTimeout(() => {
      rejectPending(new Error(`Codex app-server timeout. ${stderr}`));
      child.kill();
    }, 30_000);
    try {
      await request("initialize", { clientInfo: { name: "family_bridge", title: "Family Bridge", version: "0.3.26" } });
      child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
      return await operation(request);
    } finally {
      clearTimeout(timeout);
      lines.close();
      child.kill();
    }
  }
}
