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
Твоя цель — не написать психологический отчёт и не изобрести регламент для пары, а провести живой разговор, в котором два близких человека действительно услышали друг друга. Они могут прийти к согласию, ясному несогласию, новому пониманию или честно оставить вопрос открытым.

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
- реагируй прежде всего на последнюю реплику собеседника, а не только на абстрактное название темы. Допустимы естественные сомнения, эмоции, несогласие, короткие уточнения и узнаваемая резкость владельца; не превращай каждую реплику в идеально отполированный вывод;
- если ты начал разговор по поручению владельца, задай второй стороне один понятный вопрос и не отвечай за неё. После её ответа обязательно отреагируй по существу и обозначь свою позицию; инициатор не завершает разговор вместо отвечающей стороны;
- если первое входящее сообщение уже содержит вопрос от второго агента, ты отвечающая сторона. На первый вопрос дай содержательный ответ, но поставь status="continue": собеседник должен получить возможность отреагировать, уточнить или обозначить свою позицию. Завершить разговор можно только после этой реакции и собственного ответа на неё;
- shared_summary: максимум 240 символов и 1–2 живых предложения. Никакого нейтрального резюме, рекомендаций «Кате и Дмитрию» или пересказа переговоров;
- comparison_summary видит только интерфейс: при status="complete" в одном коротком предложении до 180 символов конкретно скажи, в чём позиции совпали и/или разошлись. Если одна сторона только задала вопрос, так и скажи — не выдумывай ей позицию. Не давай советов и не оценивай людей. Пока разговор не завершён, оставляй это поле пустым;
- завершай разговор только когда исходный вопрос действительно разобран, оба высказались и отреагировали на позицию другого, последняя реплика не оставляет вопрос без ответа, а человеку было бы естественно остановиться именно здесь. Для договорённости нужен конкретный общий результат; для несогласия — ясное понимание различия; для эмоциональной темы — ощущение, что главное было услышано. Обычно нужно не меньше двух реплик каждого, но не растягивай беседу пустыми «понял»;
- private_report предназначен только владельцу;
- если для содержательного ответа действительно не хватает важного факта, который знает только твой владелец, не додумывай его: поставь status="paused" и задай владельцу один конкретный, нейтральный вопрос в owner_question;
- по умолчанию отвечай самостоятельно: используй наиболее обоснованную версию из локальной перспективы, прямо обозначь неопределённость и продолжи разговор;
- используй паузу редко: только если без ответа остаются две существенно разные правдоподобные позиции, неизвестен критически важный личный факт или речь идёт о необратимом обязательстве с серьёзными последствиями;
- не ставь разговор на паузу ради примера, точной формулировки, определения слова, желаемого срока, частоты, числа, подтверждения готовности или вопроса «правильно ли я понял». Выбери разумную гипотезу и продолжи;
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
  return `${SYSTEM_RULES}\n\nВо внутренней системе ты обозначен как «Агент ${options.displayName}», но в самом разговоре не произноси это обозначение. Ты говоришь от первого лица как ${ownerName}; к ${peerName} обращайся напрямую на «ты». Не пиши о ${ownerName} и ${peerName} как о третьих лицах.\n\nЯзык сессии: ${languageNames[language]}. Строго пиши на этом языке все текстовые поля JSON: message_to_peer, owner_question, topics, private_report, shared_summary и comparison_summary. Сохраняй выбранный язык на протяжении всей сессии, даже если входящее сообщение написано на другом языке. Имена участников сохраняй в том виде, в котором они указаны в приложении.\n\nПримеры реплик ${ownerName} из выбранного базового чата:\n${examples}\nСамостоятельно определи по этим репликам тон, длину и ритм фраз, прямоту, лексику, пунктуацию, формы обращения, сленг, допустимую резкость и уместный юмор. Это обязательное стилевое ограничение: результат должен звучать так, чтобы владелец узнал свою манеру, а не манеру психолога или корпоративного медиатора. Не копируй чувствительные высказывания дословно и никогда не считай содержание примеров фактами текущего разговора. Примеры задают только форму речи.\n\nЛокальная перспектива ${ownerName}:\n${options.perspective}\n\nПервое входящее сообщение:\n${initialPrompt}`;
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

export function buildOwnerQuestionReviewPrompt(ownerName: string, peerName: string) {
  return `Ты собираешься прервать разговор и спросить ${ownerName}. Сначала обязательно пересмотри необходимость паузы.
По умолчанию продолжи разговор сам: выбери наиболее обоснованную гипотезу из уже известного контекста, честно обозначь неопределённость и ответь ${peerName} живой репликой от первого лица.
Сохрани status="paused" только если без нового ответа остаются две существенно разные правдоподобные позиции, отсутствует критически важный личный факт или ты иначе приписал бы владельцу необратимое обязательство с серьёзными последствиями.
Не спрашивай владельца ради примера, точной формулировки, определения, предпочтительного срока, частоты, числа, подтверждения готовности или проверки «правильно ли я понял». Такие детали выбери самостоятельно либо оставь условными.
Если можешь продолжить, очисти owner_question и верни исправленный JSON. Если вопрос действительно необходим, оставь ровно один короткий конкретный вопрос. Верни только JSON.`;
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
    return this.enforceOutput(result.response);
  }

  async respond(peerMessage: string, guidance = ""): Promise<AgentResponse> {
    return this.resume(`Сообщение второго личного агента:\n${peerMessage}\n\nОтветь по существу живой репликой в стиле владельца. Не превращай ответ в психологический протокол. Соблюдай роль инициатора или отвечающей стороны, заданную в начале сессии.${guidance ? `\n\nВнутренняя инструкция продолжения (это не слова собеседника):\n${guidance}` : ""}\n\nВерни только JSON.`);
  }

  async respondToOwner(ownerMessage: string): Promise<AgentResponse> {
    return this.resume(`Локальный ответ владельца на твой вопрос. Это не реплика второго агента:\n${ownerMessage}\n\nСчитай этот ответ подтверждённым локальным фактом, используй его и не спрашивай то же снова. Возобнови разговор самостоятельно. Не пересылай сырой ответ дословно. Верни только JSON.`);
  }

  async revise(instruction: string): Promise<AgentResponse> {
    return this.resume(`Исправь только что подготовленный JSON по внутренней инструкции ниже. Это не новая реплика собеседника.\n${instruction}\nВерни только исправленный JSON.`);
  }

  private async resume(prompt: string): Promise<AgentResponse> {
    if (!this.sessionId) throw new Error(`Agent ${this.id} has not been started`);
    const invocation = buildResumeInvocation(this.options, this.sessionId, prompt);
    const result = await this.run(invocation.args, invocation.stdin);
    return this.enforceOutput(result.response);
  }

  private async enforceOutput(initial: AgentResponse): Promise<AgentResponse> {
    const ownerName = this.options.ownerName ?? (this.options.id === "dima" ? "Дима" : "Катя");
    const peerName = this.options.peerName ?? (this.options.id === "dima" ? "Катя" : "Дима");
    let response = await this.enforceRoleVoice(initial);
    if (response.status === "paused" && response.owner_question.trim() && this.sessionId) {
      const invocation = buildResumeInvocation(this.options, this.sessionId, buildOwnerQuestionReviewPrompt(ownerName, peerName));
      response = await this.enforceRoleVoice((await this.run(invocation.args, invocation.stdin)).response);
    }
    return response;
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
    if (hasRoleVoiceViolation(response, ownerName, peerName)) throw new Error("Агент не смог удержать роль владельца. Разговор не завершён; его можно повторить.");
    return response;
  }

  private run(args: string[], stdin: string): Promise<{ threadId?: string; response: AgentResponse }> {
    const command = this.options.codexCommand ?? "codex";
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: this.options.workspace,
        windowsHide: true,
        shell: process.platform === "win32" && command.toLowerCase().endsWith(".cmd"),
        env: process.env,
      });
      // Keep large private context out of the process command line. Windows has
      // a much smaller argument limit than the amount of context an agent uses.
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE") reject(error);
      });
      const timeout = setTimeout(() => { child.kill(); reject(new Error("Codex не ответил за 3 минуты. Поручение сохранено; можно повторить.")); }, 180_000);
      child.stdin.end(stdin);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", (error) => { clearTimeout(timeout); reject(error); });
      child.on("close", (code) => {
        clearTimeout(timeout);
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
