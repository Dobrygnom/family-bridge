import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildInitialPortraits, type PersonPortrait, type RawPortrait } from "./person-portraits.js";

export interface ContextPerson {
  id: string;
  label: string;
  relationship: string;
  aliases: string[];
}

export interface RoutedTopic {
  id: string;
  title: string;
  aboutPersonIds: string[];
  discussWithPersonId: string;
  sensitivity: "direct" | "cross_person" | "unclear";
  reason: string;
  approved: boolean;
}

export interface ContextAnalysis {
  analysisVersion: number;
  sourceId: string;
  sourceHash: string;
  analyzedAt: string;
  status: "ready" | "analyzing" | "error";
  people: ContextPerson[];
  portraits?: PersonPortrait[];
  topics: RoutedTopic[];
  progress?: { stage: "analyzing" | "consolidating"; current: number; total: number };
  error?: string;
}

interface RawAnalysis {
  people: Array<{ key: string; label: string; relationship: string; aliases: string[] }>;
  portraits?: RawPortrait[];
  topics: Array<{ title: string; about_people: string[]; discuss_with: string; sensitivity: "direct" | "cross_person" | "unclear"; reason: string }>;
}

export const CONTEXT_ANALYSIS_VERSION = 4;

export function contextSourceHash(messages: Array<{ text: string }>): string {
  return createHash("sha256").update(messages.map((message) => message.text).join("\n\u0000\n"), "utf8").digest("hex");
}

export function contextAnalysisNeedsRefresh(analysis: ContextAnalysis | undefined, sourceId: string, sourceHash: string): boolean {
  return !analysis
    || analysis.analysisVersion !== CONTEXT_ANALYSIS_VERSION
    || analysis.sourceId !== sourceId
    || analysis.sourceHash !== sourceHash
    || analysis.status !== "ready";
}

export function splitContextMessages(messages: Array<{ text: string }>, maxCharacters = 50_000): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const [index, message] of messages.entries()) {
    const numbered = `[${index + 1}] ${message.text.trim()}`;
    if (!numbered.trim()) continue;
    if (current && current.length + numbered.length + 2 > maxCharacters) {
      chunks.push(current);
      current = "";
    }
    if (numbered.length <= maxCharacters) {
      current = current ? `${current}\n\n${numbered}` : numbered;
      continue;
    }
    if (current) { chunks.push(current); current = ""; }
    for (let offset = 0; offset < numbered.length; offset += maxCharacters) chunks.push(numbered.slice(offset, offset + maxCharacters));
  }
  if (current) chunks.push(current);
  return chunks;
}

export function normalizeContextAnalysis(raw: RawAnalysis, sourceId: string, sourceHash: string, previous?: ContextAnalysis, ownerName = "Вы"): ContextAnalysis {
  const normalizeName = (value: string) => value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const normalizedOwnerName = normalizeName(ownerName);
  const isOwnerPerson = (person: RawAnalysis["people"][number]) => {
    const relationship = normalizeName(person.relationship);
    return normalizeName(person.key) === "owner"
      || ["owner", "self", "владелец", "я"].includes(relationship)
      || Boolean(normalizedOwnerName && [person.label, ...person.aliases].some((value) => normalizeName(value) === normalizedOwnerName));
  };
  const ownerKeys = new Set(["owner", ...raw.people.filter(isOwnerPerson).map((person) => person.key)]);
  const rawPeople = raw.people.filter((person) => !isOwnerPerson(person));
  const used = new Set<string>(["owner"]);
  const keyToId = new Map<string, string>();
  const people = rawPeople.map((person, index) => {
    const base = person.key.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "") || `person-${index + 1}`;
    let id = base;
    let suffix = 2;
    while (used.has(id)) id = `${base}-${suffix++}`;
    used.add(id);
    keyToId.set(person.key, id);
    return { id, label: person.label.trim() || person.relationship.trim() || `Человек ${index + 1}`, relationship: person.relationship.trim(), aliases: person.aliases.map((item) => item.trim()).filter(Boolean) };
  });
  const previousApproval = new Map(previous?.topics.map((topic) => [`${topic.title}\u0000${topic.discussWithPersonId}`, topic.approved]) ?? []);
  const topics = raw.topics.flatMap((topic, index): RoutedTopic[] => {
    const discussWithPersonId = keyToId.get(topic.discuss_with);
    if (!discussWithPersonId || !topic.title.trim()) return [];
    const aboutPersonIds = topic.about_people.map((key) => keyToId.get(key)).filter((value): value is string => Boolean(value));
    const id = `topic-${createHash("sha256").update(`${topic.title}\u0000${discussWithPersonId}`).digest("hex").slice(0, 12)}-${index + 1}`;
    return [{ id, title: topic.title.trim(), aboutPersonIds, discussWithPersonId, sensitivity: topic.sensitivity, reason: topic.reason.trim(), approved: previousApproval.get(`${topic.title.trim()}\u0000${discussWithPersonId}`) ?? false }];
  });
  const portraits = buildInitialPortraits({
    raw: [
      { person_key: "owner", observations: (raw.portraits ?? []).filter((portrait) => ownerKeys.has(portrait.person_key)).flatMap((portrait) => portrait.observations) },
      ...(raw.portraits ?? []).filter((portrait) => !ownerKeys.has(portrait.person_key)),
    ],
    sourceId,
    previous: previous?.portraits,
    people: [
      { personKey: "owner", personId: "owner", label: ownerName.trim() || "Вы", relationship: "", isOwner: true },
      ...people.map((person, index) => ({ personKey: rawPeople[index]?.key ?? person.id, personId: person.id, label: person.label, relationship: person.relationship, isOwner: false })),
    ],
  });
  return { analysisVersion: CONTEXT_ANALYSIS_VERSION, sourceId, sourceHash, analyzedAt: new Date().toISOString(), status: "ready", people, portraits, topics };
}

export function topicsForCounterpart(analysis: ContextAnalysis | undefined, personId: string | undefined): RoutedTopic[] {
  if (!analysis || !personId) return [];
  return analysis.topics.filter((topic) => topic.approved && topic.discussWithPersonId === personId);
}

export function routeSensitivity(aboutPersonIds: string[], discussWithPersonId: string): RoutedTopic["sensitivity"] {
  if (!aboutPersonIds.length) return "unclear";
  return aboutPersonIds.some((personId) => personId !== discussWithPersonId) ? "cross_person" : "direct";
}

export class CodexContextAnalyzer {
  constructor(private readonly command: string, private readonly workspace: string, private readonly schemaPath: string) {}

  async analyze(input: { sourceId: string; sourceHash: string; ownerName: string; language: string; messages: Array<{ text: string }>; previous?: ContextAnalysis; onProgress?: (progress: NonNullable<ContextAnalysis["progress"]>) => void | Promise<void> }): Promise<ContextAnalysis> {
    await mkdir(this.workspace, { recursive: true });
    const chunks = splitContextMessages(input.messages);
    if (!chunks.length) throw new Error("В выбранном чате нет текстовых реплик пользователя");
    const total = chunks.length + 1;
    let completed = 0;
    const rawParts = await this.mapConcurrent(chunks, 2, async (transcript) => {
      const raw = await this.runCached(this.analysisPrompt(input.ownerName, input.language, transcript));
      completed += 1;
      await input.onProgress?.({ stage: "analyzing", current: completed, total });
      return raw;
    });
    await input.onProgress?.({ stage: "consolidating", current: total, total });
    const raw = await this.consolidate(rawParts, input.ownerName, input.language);
    return normalizeContextAnalysis(raw, input.sourceId, input.sourceHash, input.previous, input.ownerName);
  }

  private analysisPrompt(ownerName: string, language: string, transcript: string) {
    return `Ты выполняешь первый, исследовательский этап семейно-психологического анализа личного чата владельца ${ownerName || "приложения"}. Это не итоговый список тем и не суммаризация сообщений. Твоя задача — сохранить материал, из которого следующий этап сможет рекомендовать содержательные разговоры.

Найди упоминаемых близких людей, кроме самого владельца. Для каждого дай короткий стабильный key латиницей, отображаемое имя или нейтральную роль, тип отношений и встречающиеся формы имени.

В portraits составь компактный портрет самого владельца и найденных людей. Для владельца всегда используй person_key="owner", для остальных — тот же key, что в people. Добавляй только отдельные короткие наблюдения о конкретном человеке:
- fact — явно сообщённый факт;
- view — его позиция или объяснение;
- preference — желание, потребность или граница;
- pattern — устойчивый способ реагирования, только если он действительно повторяется или прямо описан;
- uncertainty — важная неопределённость самого человека.
Не создавай портрет пары или отношений как отдельной сущности. Не ставь диагнозов, не превращай единичную эмоцию в черту характера и не выдавай взгляд владельца на другого человека за подтверждённую истину. Сохрани формулировку как осторожное наблюдение о конкретном человеке.

В topics запиши не названия сообщений, а предварительные психологические гипотезы о динамике отношений: повторяющиеся эпизоды, неудовлетворённые потребности, болезненные циклы, противоречивые ожидания, нерешённые решения, попытки сближения или защиты и то, что уже пробовали делать. Одиночную бытовую реплику не превращай в тему без признака напряжения, повторения, важного выбора или потребности в восстановлении отношений.

Для каждой предварительной гипотезы обязательно раздели:
- about_people: о ком эта тема;
- discuss_with: с кем её следует обсуждать.

В title кратко назови предполагаемую динамику. В reason зафиксируй наблюдаемую основу гипотезы, но не копируй сообщения дословно. Не объявляй одностороннюю версию владельца объективной истиной. Если тема о третьем человеке предназначена партнёру, это cross_person. Не ставь диагнозов и не выдумывай людей. Если адресат неясен, используй sensitivity=unclear, но discuss_with всё равно должен ссылаться на наиболее вероятного человека. Язык названий и объяснений: ${language}.

Верни только JSON по схеме. Исходные реплики владельца:
${transcript}`;
  }

  private async consolidate(parts: RawAnalysis[], ownerName: string, language: string): Promise<RawAnalysis> {
    const serialized = JSON.stringify(parts);
    if (serialized.length > 120_000 && parts.length > 2) {
      const middle = Math.ceil(parts.length / 2);
      return this.consolidate([
        await this.consolidate(parts.slice(0, middle), ownerName, language),
        await this.consolidate(parts.slice(middle), ownerName, language),
      ], ownerName, language);
    }
    return this.runCached(`Выступи как опытный семейный психолог и преврати исследовательские заметки по личному чату ${ownerName || "владельца"} в портреты конкретных людей и рекомендуемую повестку разговоров между двумя семейными агентами.

Это не суммаризация сообщений и не каталог слов, которые встречались в чате. Сначала мысленно восстанови происходившую динамику отношений: что повторяется, где стороны застряли, какая потребность не услышана, какое решение откладывается, что требует прояснения, восстановления доверия или практической договорённости. Затем выбери именно те разговоры, которые ты как семейный психолог действительно посоветовал бы провести.

Каждая итоговая тема должна одновременно иметь:
- конкретное напряжение, паттерн, нерешённый выбор или потребность;
- понятного адресата discuss_with;
- конструктивную цель, которой агенты могут достичь в разговоре;
- достаточную опору в заметках, без выдуманных фактов и диагнозов.

Не создавай тему из каждого сообщения. Объединяй разные эпизоды одного повторяющегося цикла, но не склеивай разные решения, травмы или договорённости. Исключи простые новости, уже завершённые вопросы, общий эмоциональный выплеск без запроса к другому человеку и сугубо индивидуальные темы, для которых разговор с указанным человеком ничего не может изменить.

Title — это узнаваемая конкретная задача разговора, а не рубрика и не абстрактное существительное. Формулируй его как действие и желаемый результат. Плохо: «Доверие», «Границы в браке», «Общение после расставания», «Отношения с мужем». Хорошо: «Согласовать, какие контакты после расставания допустимы и как сообщать о них», «Обсудить, что каждый считает изменой и какие границы нужны дальше», «Договориться, как сообщать болезненные факты без давления и допроса».

Reason должен помогать понять рекомендацию обоим людям, включая того, кто не видел исходный чат, и состоять из трёх коротких частей: «Наблюдаемая динамика: … Психологическая цель: … Первый вопрос: …». В наблюдаемой динамике дай 1–2 конкретных предложения: какая ситуация или повторяющийся эпизод имеется в виду, что в нём задевает или остаётся непонятным. Не используй без опоры слова «это», «ситуация», «проблема» и другие ссылки, понятные только автору исходного сообщения. Описывай динамику как обоснованную гипотезу, а не установленную истину. Не цитируй интимные признания дословно, но и не обезличивай формулировку настолько, что владелец или адресат не узнают, о чём речь. Весь reason должен оставаться компактным, а не превращаться в эссе.

Одинаковых людей объедини, сохранив известные имена, роли и aliases. Удали только настоящие дубликаты тем. Не склеивай разные конфликты, потребности и договорённости в одну общую формулировку. Сохрани все различимые темы из всех частей. about_people и discuss_with должны ссылаться только на итоговые key людей. Пересчитай sensitivity: cross_person, если тема хотя бы об одном человеке, отличном от discuss_with; direct, если она только об адресате; unclear, если уверенности недостаточно. Не добавляй новых фактов. Язык: ${language}.

Собери portraits для person_key="owner" и каждого итогового человека. Удали дубликаты наблюдений, сохрани различимые факты, позиции, предпочтения, устойчивые паттерны и существенные неопределённости. Обычно достаточно 5–15 наиболее содержательных наблюдений на человека. Каждое наблюдение должно описывать только одного человека. Взгляд владельца на другого человека формулируй осторожно, не превращая его в объективный факт. Не создавай сущность для пары или отношений.

Расположи темы в порядке ожидаемой пользы: сначала разговоры, которые сильнее всего влияют на безопасность, доверие, повторяющиеся конфликты и важные решения, затем менее срочные.

Верни только JSON по схеме. Частичные результаты:
${serialized}`);
  }

  private async runCached(prompt: string): Promise<RawAnalysis> {
    const key = createHash("sha256").update(prompt).digest("hex");
    const file = path.join(this.workspace, `analysis-${key}.json`);
    try { return JSON.parse(await readFile(file, "utf8")) as RawAnalysis; }
    catch { /* a missing or invalid partial result is recalculated */ }
    const result = await this.run(prompt);
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(result), "utf8");
    await rename(temporary, file);
    return result;
  }

  private async mapConcurrent<T, R>(items: T[], concurrency: number, operation: (item: T) => Promise<R>): Promise<R[]> {
    const result = new Array<R>(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        result[index] = await operation(items[index]);
      }
    });
    await Promise.all(workers);
    return result;
  }

  private run(prompt: string): Promise<RawAnalysis> {
    const args = ["exec", "--ephemeral", "--skip-git-repo-check", "-s", "read-only", "--json", "--output-schema", this.schemaPath, "-C", this.workspace, "-"];
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, args, { cwd: this.workspace, shell: process.platform === "win32" && this.command.toLowerCase().endsWith(".cmd"), windowsHide: true });
      child.stdin.end(prompt);
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error("Codex context analysis timed out"));
      }, 30 * 60_000);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      child.on("close", (code) => {
        clearTimeout(timeout);
        if (code !== 0) { reject(new Error(`Codex context analysis exited with ${code}: ${stderr || stdout}`)); return; }
        try {
          let finalText = "";
          for (const line of stdout.split(/\r?\n/)) {
            if (!line.trim().startsWith("{")) continue;
            const event = JSON.parse(line) as { type?: string; item?: { type?: string; text?: string }; message?: string };
            if (event.type === "item.completed" && event.item?.type === "agent_message") finalText = event.item.text ?? "";
            if (event.type === "error") throw new Error(event.message ?? "Codex context analysis failed");
          }
          if (!finalText) throw new Error(`Codex did not return context analysis. ${stderr}`);
          resolve(JSON.parse(finalText) as RawAnalysis);
        } catch (error) { reject(error); }
      });
    });
  }
}
