import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
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
  ownerName?: string;
  peerName?: string;
  perspective: string;
  workspace: string;
  schemaPath: string;
  codexCommand?: string;
  language?: "ru" | "en" | "cs" | "fr";
  communicationExamples?: string;
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
- если для содержательного ответа действительно не хватает важного факта, который знает только твой владелец, не додумывай его: поставь status="paused" и задай владельцу один конкретный, нейтральный вопрос в owner_question;
- используй паузу редко: только когда без ответа существенно меняется вывод или договорённость, а не для любой мелкой неопределённости;
- owner_question видит только твой владелец. Не копируй этот вопрос в message_to_peer и не проси второго агента передать его человеку;
- после ответа владельца, «не знаю» или отказа не задавай тот же вопрос повторно. Продолжи с доступными фактами и при необходимости сформулируй условный вывод;
- если status не paused, owner_question должен быть пустой строкой;
- никаких tool calls: верни только объект по заданной JSON Schema.
`;

export function buildInitialPrompt(options: CodexRuntimeOptions, initialPrompt: string): string {
  const ownerName = options.ownerName ?? (options.id === "dima" ? "Дима" : "Катя");
  const peerName = options.peerName ?? (options.id === "dima" ? "Катя" : "Дима");
  const language = options.language ?? "ru";
  const examples = options.communicationExamples ?? "Примеры отсутствуют: используй спокойный, прямой и естественный тон.";
  return `${SYSTEM_RULES}\n\nТебя зовут «Агент ${options.displayName}». Твой владелец — ${ownerName}. Второй агент представляет ${peerName}. Всегда называй людей по именам; не используй двусмысленные выражения «твой владелец» или «мой владелец» в сообщении второму агенту.\n\nЯзык сессии: ${languageNames[language]}. Строго пиши на этом языке все текстовые поля JSON: message_to_peer, owner_question, topics, private_report и shared_summary. Сохраняй выбранный язык на протяжении всей сессии, даже если входящее сообщение написано на другом языке. Имена участников сохраняй в том виде, в котором они указаны в приложении.\n\nПримеры реплик ${ownerName} из выбранного базового чата:\n${examples}\nСамостоятельно определи по этим репликам тон, длину и ритм фраз, прямоту, лексику, пунктуацию, формы обращения и уместный юмор. Веди текущий разговор в узнаваемой манере, но не копируй чувствительные высказывания дословно, не изображай владельца и никогда не считай содержание примеров фактами текущего разговора. Примеры задают только форму речи.\n\nЛокальная перспектива ${ownerName}:\n${options.perspective}\n\nПервое входящее сообщение:\n${initialPrompt}`;
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
    return this.resume(`Сообщение второго семейного агента:\n${peerMessage}\n\nПродолжи переговоры по правилам сессии. Верни только JSON.`);
  }

  async respondToOwner(ownerMessage: string): Promise<AgentResponse> {
    return this.resume(`Локальный ответ владельца на твой вопрос. Это не реплика второго агента:\n${ownerMessage}\n\nВозобнови переговоры по правилам сессии. Не пересылай сырой ответ дословно. Верни только JSON.`);
  }

  private async resume(prompt: string): Promise<AgentResponse> {
    if (!this.sessionId) throw new Error(`Agent ${this.id} has not been started`);
    const result = await this.run([
      "exec",
      "resume",
      "--skip-git-repo-check",
      "--json",
      "--output-schema",
      this.options.schemaPath,
      this.sessionId,
      prompt,
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

export function selectWindowsCodexCommand(matches: string[]): string {
  const normalized = matches.map((candidate) => candidate.trim()).filter(Boolean);
  return normalized.find((candidate) => candidate.toLowerCase().endsWith(".exe"))
    ?? normalized.find((candidate) => candidate.toLowerCase().endsWith(".cmd"))
    ?? normalized.find((candidate) => candidate.toLowerCase().endsWith(".bat"))
    ?? "codex.cmd";
}

export function findWindowsCodexExecutable(localAppData = process.env.LOCALAPPDATA): string | undefined {
  if (!localAppData) return undefined;
  const binRoot = path.join(localAppData, "OpenAI", "Codex", "bin");
  const candidates = [path.join(binRoot, "codex.exe")];
  try {
    for (const entry of readdirSync(binRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(path.join(binRoot, entry.name, "codex.exe"));
    }
  } catch { /* Codex Desktop may not be installed */ }
  return candidates
    .filter((candidate) => existsSync(candidate))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];
}

export function findMacCodexExecutable(
  home = os.homedir(),
  applicationRoots = ["/Applications", path.join(home, "Applications")],
): string | undefined {
  const candidates = applicationRoots.flatMap((root) => [
    path.join(root, "Codex.app", "Contents", "Resources", "codex"),
    path.join(root, "ChatGPT.app", "Contents", "Resources", "codex"),
  ]);
  return candidates.find((candidate) => existsSync(candidate));
}

export function defaultCodexCommand(): string {
  if (process.env.CODEX_CLI_PATH && existsSync(process.env.CODEX_CLI_PATH)) {
    return process.env.CODEX_CLI_PATH;
  }
  if (process.platform === "win32") {
    const desktopExecutable = findWindowsCodexExecutable();
    if (desktopExecutable) return desktopExecutable;
    try {
      const matches = execFileSync("where.exe", ["codex"], { encoding: "utf8" })
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      return selectWindowsCodexCommand(matches);
    } catch {
      return "codex.cmd";
    }
  }
  if (process.platform === "darwin") {
    const desktopExecutable = findMacCodexExecutable();
    if (desktopExecutable) return desktopExecutable;
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
