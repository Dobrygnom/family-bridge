import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";

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
  sourceId: string;
  sourceHash: string;
  analyzedAt: string;
  status: "ready" | "analyzing" | "error";
  people: ContextPerson[];
  topics: RoutedTopic[];
  progress?: { stage: "analyzing" | "consolidating"; current: number; total: number };
  error?: string;
}

interface RawAnalysis {
  people: Array<{ key: string; label: string; relationship: string; aliases: string[] }>;
  topics: Array<{ title: string; about_people: string[]; discuss_with: string; sensitivity: "direct" | "cross_person" | "unclear"; reason: string }>;
}

export function contextSourceHash(messages: Array<{ text: string }>): string {
  return createHash("sha256").update(messages.map((message) => message.text).join("\n\u0000\n"), "utf8").digest("hex");
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

export function normalizeContextAnalysis(raw: RawAnalysis, sourceId: string, sourceHash: string, previous?: ContextAnalysis): ContextAnalysis {
  const used = new Set<string>();
  const keyToId = new Map<string, string>();
  const people = raw.people.map((person, index) => {
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
  return { sourceId, sourceHash, analyzedAt: new Date().toISOString(), status: "ready", people, topics };
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
    const total = chunks.length + (chunks.length > 1 ? 1 : 0);
    let completed = 0;
    const rawParts = await this.mapConcurrent(chunks, 2, async (transcript) => {
      const raw = await this.run(this.analysisPrompt(input.ownerName, input.language, transcript));
      completed += 1;
      await input.onProgress?.({ stage: "analyzing", current: completed, total });
      return raw;
    });
    let raw = rawParts[0];
    if (rawParts.length > 1) {
      await input.onProgress?.({ stage: "consolidating", current: total, total });
      raw = await this.consolidate(rawParts, input.language);
    }
    return normalizeContextAnalysis(raw, input.sourceId, input.sourceHash, input.previous);
  }

  private analysisPrompt(ownerName: string, language: string, transcript: string) {
    return `Проанализируй только локальный личный контекст владельца ${ownerName || "приложения"} и подготовь маршрутизацию будущих разговоров между семейными агентами.

Найди упоминаемых близких людей, кроме самого владельца. Для каждого дай короткий стабильный key латиницей, отображаемое имя или нейтральную роль, тип отношений и встречающиеся формы имени.

Подготовь все различимые конкретные нейтральные темы, которые действительно стоит обсудить. Не объединяй разные конфликты, потребности или договорённости в одну общую тему. Для каждой темы обязательно раздели:
- about_people: о ком эта тема;
- discuss_with: с кем её следует обсуждать.

Если тема о любовнике предназначена мужу или наоборот, это cross_person. Не цитируй интимные признания, не раскрывай детали в названии, не ставь диагнозов и не выдумывай людей. Если адресат неясен, используй sensitivity=unclear, но discuss_with всё равно должен ссылаться на наиболее вероятного человека. Язык названий и объяснений: ${language}.

Верни только JSON по схеме. Исходные реплики владельца:
${transcript}`;
  }

  private async consolidate(parts: RawAnalysis[], language: string): Promise<RawAnalysis> {
    const serialized = JSON.stringify(parts);
    if (serialized.length > 120_000 && parts.length > 2) {
      const middle = Math.ceil(parts.length / 2);
      return this.consolidate([
        await this.consolidate(parts.slice(0, middle), language),
        await this.consolidate(parts.slice(middle), language),
      ], language);
    }
    return this.run(`Объедини результаты анализа частей одного личного чата в единый реестр людей и тем.

Одинаковых людей объедини, сохранив известные имена, роли и aliases. Удали только настоящие дубликаты тем. Не склеивай разные конфликты, потребности и договорённости в одну общую формулировку. Сохрани все различимые темы из всех частей. about_people и discuss_with должны ссылаться только на итоговые key людей. Пересчитай sensitivity: cross_person, если тема хотя бы об одном человеке, отличном от discuss_with; direct, если она только об адресате; unclear, если уверенности недостаточно. Не добавляй новых фактов. Язык: ${language}.

Верни только JSON по схеме. Частичные результаты:
${serialized}`);
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
      }, 15 * 60_000);
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
