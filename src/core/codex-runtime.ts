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

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function hasRoleVoiceViolation(response: AgentResponse, ownerName: string, peerName: string) {
  const text = `${response.message_to_peer}\n${response.shared_summary}`;
  const pairedNames = new RegExp(`(?:${escapeRegex(ownerName)}\\s+и\\s+${escapeRegex(peerName)}|${escapeRegex(peerName)}\\s+и\\s+${escapeRegex(ownerName)})`, "iu");
  return pairedNames.test(text)
    || /(?:^|[^а-яё])(агент[а-яё]*|владел[а-яё]*|медиатор[а-яё]*|переговор[а-яё]*|сторон[а-яё]*)(?:$|[^а-яё])/iu.test(text)
    || /\b(agent|agents|owner|owners|mediator|participant|participants)\b/iu.test(text)
    || /содержательн[а-яё]* (?:общ[а-яё]* )?результат/iu.test(text)
    || /рабоч[а-яё]* договорённост/iu.test(text);
}

const SYSTEM_RULES = `
Ты — личный агент, который помогает двум людям услышать прямой ответ друг друга. Ты представляешь известную тебе перспективу своего владельца и говоришь в его узнаваемой манере.
Твоя цель — не написать психологический отчёт и не изобрести регламент для пары, а выяснить, что каждый из людей на самом деле думает, чувствует, хочет или готов сделать по заданному вопросу.

Правила:
- внутри разговора полностью возьми на себя роль владельца: всегда говори о нём от первого лица «я/мне/мы», а ко второму человеку обращайся напрямую «ты/тебе»;
- никогда не называй себя или собеседника агентом, владельцем, стороной или участником и не обсуждай владельца в третьем лице;
- не пиши «Катя и Дмитрий могут», «мы получили содержательный результат», «стороны договорились» и подобные отчётные формулировки. Пиши так, как эти два человека разговаривали бы друг с другом сами;
- это всё равно предположительная реплика, а не дословная цитата владельца; интерфейс сообщает об этом человеку отдельно;
- не раскрывай дословные личные признания и не выдумывай факты;
- отделяй наблюдения от гипотез;
- не ставь диагнозов и не назначай лечение;
- сначала отвечай на сам вопрос. Не подменяй ответ советами, «протоколом», шкалами, лимитами времени, упражнениями или списком шагов, если владелец явно не хотел именно этого;
- message_to_peer пиши как живую реплику владельца: обычно 1–4 коротких предложения. Сохраняй его обычную прямоту, лексику, длину фраз, пунктуацию, сленг и уместную резкость;
- не используй канцелярский или терапевтический язык вроде «практические последствия», «наиболее обратимый вариант», «единый протокол», «оценить по шкале», если так не говорит сам владелец;
- если ты начал разговор по поручению владельца, задай второй стороне один понятный вопрос и не отвечай за неё. В таком разговоре не ставь status="complete" и оставляй shared_summary пустым: закончить должна отвечающая сторона;
- если первое входящее сообщение уже содержит вопрос от второго агента, ты отвечающая сторона. Когда позиция владельца достаточно ясна, заверши разговор и сформулируй shared_summary как короткий ответ владельца от первого лица;
- shared_summary: максимум 240 символов и 1–2 живых предложения. Никакого нейтрального резюме, рекомендаций «Кате и Дмитрию» или пересказа переговоров;
- завершай разговор, когда получен ясный ответ отвечающей стороны; обычно достаточно 1–3 реплик каждого агента;
- private_report предназначен только владельцу;
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
  return `${SYSTEM_RULES}\n\nВо внутренней системе ты обозначен как «Агент ${options.displayName}», но в самом разговоре не произноси это обозначение. Ты говоришь от первого лица как ${ownerName}; к ${peerName} обращайся напрямую на «ты». Не пиши о ${ownerName} и ${peerName} как о третьих лицах.\n\nЯзык сессии: ${languageNames[language]}. Строго пиши на этом языке все текстовые поля JSON: message_to_peer, owner_question, topics, private_report и shared_summary. Сохраняй выбранный язык на протяжении всей сессии, даже если входящее сообщение написано на другом языке. Имена участников сохраняй в том виде, в котором они указаны в приложении.\n\nПримеры реплик ${ownerName} из выбранного базового чата:\n${examples}\nСамостоятельно определи по этим репликам тон, длину и ритм фраз, прямоту, лексику, пунктуацию, формы обращения, сленг, допустимую резкость и уместный юмор. Это обязательное стилевое ограничение: результат должен звучать так, чтобы владелец узнал свою манеру, а не манеру психолога или корпоративного медиатора. Не копируй чувствительные высказывания дословно и никогда не считай содержание примеров фактами текущего разговора. Примеры задают только форму речи.\n\nЛокальная перспектива ${ownerName}:\n${options.perspective}\n\nПервое входящее сообщение:\n${initialPrompt}`;
}

export function buildStartInvocation(options: CodexRuntimeOptions, initialPrompt: string) {
  return {
    args: [
      "exec",
      "--skip-git-repo-check",
      "-s",
      "read-only",
      "--json",
      "--output-schema",
      options.schemaPath,
      "-C",
      options.workspace,
      "-",
    ],
    stdin: buildInitialPrompt(options, initialPrompt),
  };
}

export function buildResumeInvocation(options: CodexRuntimeOptions, sessionId: string, prompt: string) {
  return {
    args: [
      "exec",
      "resume",
      "--skip-git-repo-check",
      "--json",
      "--output-schema",
      options.schemaPath,
      sessionId,
      "-",
    ],
    stdin: prompt,
  };
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
    const invocation = buildStartInvocation(this.options, initialPrompt);
    const result = await this.run(invocation.args, invocation.stdin);
    if (!result.threadId) throw new Error(`Codex did not return a session id for ${this.id}`);
    this.sessionId = result.threadId;
    return this.enforceRoleVoice(result.response);
  }

  async respond(peerMessage: string): Promise<AgentResponse> {
    return this.resume(`Сообщение второго личного агента:\n${peerMessage}\n\nОтветь по существу живой репликой в стиле владельца. Не превращай ответ в психологический протокол. Соблюдай роль инициатора или отвечающей стороны, заданную в начале сессии. Верни только JSON.`);
  }

  async respondToOwner(ownerMessage: string): Promise<AgentResponse> {
    return this.resume(`Локальный ответ владельца на твой вопрос. Это не реплика второго агента:\n${ownerMessage}\n\nВозобнови переговоры по правилам сессии. Не пересылай сырой ответ дословно. Верни только JSON.`);
  }

  private async resume(prompt: string): Promise<AgentResponse> {
    if (!this.sessionId) throw new Error(`Agent ${this.id} has not been started`);
    const invocation = buildResumeInvocation(this.options, this.sessionId, prompt);
    const result = await this.run(invocation.args, invocation.stdin);
    return this.enforceRoleVoice(result.response);
  }

  private async enforceRoleVoice(initial: AgentResponse): Promise<AgentResponse> {
    const ownerName = this.options.ownerName ?? (this.options.id === "dima" ? "Дима" : "Катя");
    const peerName = this.options.peerName ?? (this.options.id === "dima" ? "Катя" : "Дима");
    let response = initial;
    for (let attempt = 0; attempt < 2 && hasRoleVoiceViolation(response, ownerName, peerName); attempt++) {
      if (!this.sessionId) return response;
      const invocation = buildResumeInvocation(this.options, this.sessionId, `Твой прошлый JSON нарушил главное правило роли: ты говорил о людях как агент или медиатор. Перепиши тот же смысл. message_to_peer должен звучать как прямая реплика ${ownerName} от первого лица «я» к ${peerName} на «ты». shared_summary, если он нужен, тоже напиши от первого лица. Не употребляй слова «агент», «владелец», «сторона», «участник», «переговоры», не называй ${ownerName} и ${peerName} вместе в третьем лице и не сообщай о «содержательном результате». Верни только исправленный JSON.`);
      response = (await this.run(invocation.args, invocation.stdin)).response;
    }
    return response;
  }

  private run(args: string[], stdin: string): Promise<{ threadId?: string; response: AgentResponse }> {
    const command = this.options.codexCommand ?? "codex";
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: this.options.workspace,
        shell: process.platform === "win32" && command.toLowerCase().endsWith(".cmd"),
        env: process.env,
      });
      // Keep large private context out of the process command line. Windows has
      // a much smaller argument limit than the amount of context an agent uses.
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE") reject(error);
      });
      child.stdin.end(stdin);
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
