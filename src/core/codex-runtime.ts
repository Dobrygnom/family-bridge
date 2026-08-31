import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentId, AgentResponse, AgentRuntime } from "./types.js";

interface CodexJsonEvent {
  type?: string;
  thread_id?: string;
  item?: {
    type?: string;
    text?: string;
  };
  message?: string;
  error?: { message?: string };
}

export interface CodexRuntimeOptions {
  id: AgentId;
  displayName: string;
  perspective: string;
  workspace: string;
  schemaPath: string;
  codexCommand?: string;
  language?: "ru" | "en" | "cs" | "fr";
  communicationStyle?: string;
}

const languageNames = { ru: "русском", en: "английском", cs: "чешском", fr: "французском" } as const;

const SYSTEM_RULES = `
Ты — автономный семейный медиатор, представляющий перспективу своего владельца, но не являющийся его адвокатом.
Твоя цель — вместе со вторым агентом обнаружить недопонимания и выработать реалистичные договорённости.

Правила:
- общайся только со вторым агентом; не притворяйся владельцем;
- не раскрывай дословные личные признания и не выдумывай факты;
- отделяй наблюдения от гипотез;
- не ставь диагнозов и не назначай лечение;
- предлагай конкретные, проверяемые и взаимные шаги;
- завершай разговор, когда появился содержательный общий результат;
- для demo достаточно 2–4 реплик каждого агента;
- private_report предназначен только владельцу;
- shared_summary должен быть нейтральным и допустимым для обоих;
- никаких tool calls: верни только объект по заданной JSON Schema.
`;

export function buildInitialPrompt(options: CodexRuntimeOptions, initialPrompt: string): string {
  const ownerName = options.id === "dima" ? "Дима" : "Катя";
  const peerName = options.id === "dima" ? "Катя" : "Дима";
  const language = options.language ?? "ru";
  const style = options.communicationStyle ?? "Профиль манеры общения отсутствует: используй спокойный, прямой и естественный тон.";
  return `${SYSTEM_RULES}\n\nТебя зовут «Агент ${options.displayName}». Твой владелец — ${ownerName}. Второй агент представляет ${peerName}. Всегда называй людей по именам; не используй двусмысленные выражения «твой владелец» или «мой владелец» в сообщении второму агенту.\n\nЯзык сессии: ${languageNames[language]}. Строго пиши на этом языке все текстовые поля JSON: message_to_peer, topics, private_report и shared_summary. Сохраняй выбранный язык на протяжении всей сессии, даже если входящее сообщение написано на другом языке. Имена Дима и Катя не переводи.\n\nМанера общения ${ownerName}:\n${style}\nАдаптируй тон, длину фраз, прямоту, лексику, пунктуацию и уместный юмор по этому профилю. Не копируй чувствительные высказывания дословно, не изображай владельца и не переноси факты из примеров стиля в текущий разговор.\n\nЛокальная перспектива ${ownerName}:\n${options.perspective}\n\nПервое входящее сообщение:\n${initialPrompt}`;
}

export class CodexCliAgent implements AgentRuntime {
  readonly id: AgentId;
  private sessionId?: string;

  constructor(private readonly options: CodexRuntimeOptions) {
    this.id = options.id;
  }

  get currentSessionId(): string | undefined {
    return this.sessionId;
  }

  async start(initialPrompt: string): Promise<AgentResponse> {
    await mkdir(this.options.workspace, { recursive: true });
    const prompt = buildInitialPrompt(this.options, initialPrompt);
    const result = await this.run([
      "exec",
      "--skip-git-repo-check",
      "-s",
      "read-only",
      "--json",
      "--output-schema",
      this.options.schemaPath,
      "-C",
      this.options.workspace,
      prompt,
    ]);
    if (!result.threadId) throw new Error(`Codex did not return a session id for ${this.id}`);
    this.sessionId = result.threadId;
    return result.response;
  }

  async respond(peerMessage: string): Promise<AgentResponse> {
    if (!this.sessionId) throw new Error(`Agent ${this.id} has not been started`);
    const result = await this.run([
      "exec",
      "resume",
      "--skip-git-repo-check",
      "--json",
      "--output-schema",
      this.options.schemaPath,
      this.sessionId,
      `Сообщение второго семейного агента:\n${peerMessage}\n\nПродолжи переговоры по правилам сессии. Верни только JSON.`,
    ]);
    return result.response;
  }

  private run(args: string[]): Promise<{ threadId?: string; response: AgentResponse }> {
    const command = this.options.codexCommand ?? "codex";
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: this.options.workspace,
        shell: process.platform === "win32" && command.toLowerCase().endsWith(".cmd"),
        env: process.env,
      });
      // Codex appends piped stdin to an argument prompt. Close the inherited
      // pipe immediately or a non-interactive child waits forever for EOF.
      child.stdin.end();
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`Codex exited with ${code}: ${stderr || stdout}`));
          return;
        }
        try {
          let threadId: string | undefined;
          let finalText: string | undefined;
          for (const line of stdout.split(/\r?\n/)) {
            if (!line.trim().startsWith("{")) continue;
            const event = JSON.parse(line) as CodexJsonEvent;
            if (event.type === "thread.started") threadId = event.thread_id;
            if (event.type === "item.completed" && event.item?.type === "agent_message") {
              finalText = event.item.text;
            }
            if (event.type === "error") {
              throw new Error(event.message ?? event.error?.message ?? "Unknown Codex error");
            }
          }
          if (!finalText) throw new Error(`No final agent message. stderr: ${stderr}`);
          const response = JSON.parse(finalText) as AgentResponse;
          resolve({ threadId, response });
        } catch (error) {
          reject(error);
        }
      });
    });
  }
}

export function defaultCodexCommand(): string {
  if (process.env.CODEX_CLI_PATH && existsSync(process.env.CODEX_CLI_PATH)) {
    return process.env.CODEX_CLI_PATH;
  }
  if (process.platform === "win32") {
    try {
      const matches = execFileSync("where.exe", ["codex"], { encoding: "utf8" })
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      return matches.find((candidate) => candidate.toLowerCase().endsWith(".exe")) ?? matches[0] ?? "codex.cmd";
    } catch {
      return "codex.cmd";
    }
  }
  const unixCandidates = [
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    path.join(os.homedir(), ".local", "bin", "codex"),
    path.join(os.homedir(), ".npm-global", "bin", "codex"),
  ];
  const installed = unixCandidates.find((candidate) => existsSync(candidate));
  if (installed) return installed;
  return "codex";
}

export function resolveAgentWorkspace(root: string, id: AgentId): string {
  return path.join(root, ".family-bridge", "demo", id);
}
