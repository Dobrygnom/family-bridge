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
  error?: string;
}

interface RawAnalysis {
  people: Array<{ key: string; label: string; relationship: string; aliases: string[] }>;
  topics: Array<{ title: string; about_people: string[]; discuss_with: string; sensitivity: "direct" | "cross_person" | "unclear"; reason: string }>;
}

export function contextSourceHash(messages: Array<{ text: string }>): string {
  return createHash("sha256").update(messages.map((message) => message.text).join("\n\u0000\n"), "utf8").digest("hex");
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

  async analyze(input: { sourceId: string; sourceHash: string; ownerName: string; language: string; messages: Array<{ text: string }>; previous?: ContextAnalysis }): Promise<ContextAnalysis> {
    await mkdir(this.workspace, { recursive: true });
    const transcript = input.messages.map((message, index) => `[${index + 1}] ${message.text}`).join("\n\n").slice(-100_000);
    const prompt = `Проанализируй только локальный личный контекст владельца ${input.ownerName || "приложения"} и подготовь маршрутизацию будущих разговоров между семейными агентами.

Найди упоминаемых близких людей, кроме самого владельца. Для каждого дай короткий стабильный key латиницей, отображаемое имя или нейтральную роль, тип отношений и встречающиеся формы имени.

Подготовь конкретные нейтральные темы, которые действительно стоит обсудить. Для каждой темы обязательно раздели:
- about_people: о ком эта тема;
- discuss_with: с кем её следует обсуждать.

Если тема о любовнике предназначена мужу или наоборот, это cross_person. Не цитируй интимные признания, не раскрывай детали в названии, не ставь диагнозов и не выдумывай людей. Если адресат неясен, используй sensitivity=unclear, но discuss_with всё равно должен ссылаться на наиболее вероятного человека. Язык названий и объяснений: ${input.language}.

Верни только JSON по схеме. Исходные реплики владельца:
${transcript}`;
    const raw = await this.run(prompt);
    return normalizeContextAnalysis(raw, input.sourceId, input.sourceHash, input.previous);
  }

  private run(prompt: string): Promise<RawAnalysis> {
    const args = ["exec", "--skip-git-repo-check", "-s", "read-only", "--json", "--output-schema", this.schemaPath, "-C", this.workspace, prompt];
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, args, { cwd: this.workspace, shell: process.platform === "win32" && this.command.toLowerCase().endsWith(".cmd"), windowsHide: true });
      child.stdin.end();
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.once("error", reject);
      child.on("close", (code) => {
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
