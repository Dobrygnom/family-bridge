import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { preferredModelArgs } from "./codex-model.js";
import { buildInitialPortraits, type PersonPortrait, type RawPortrait } from "./person-portraits.js";
import { buildDiscoveryPrompt, buildTopicSelectionPrompt } from "./topic-discovery-prompts.js";

export interface AnalysisMessage { text: string; created_at?: string }

export function sourceThroughDate(messages: AnalysisMessage[]): string | undefined {
  const dates = messages.flatMap((message) => message.created_at && Number.isFinite(Date.parse(message.created_at)) ? [new Date(message.created_at).toISOString()] : []);
  return dates.sort().at(-1);
}

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
  sourceTitles?: string[];
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
  model?: string;
  sourceThrough?: string;
}

interface RawAnalysis {
  people: Array<{ key: string; label: string; relationship: string; aliases: string[] }>;
  portraits?: RawPortrait[];
  topics: Array<{ title: string; about_people: string[]; discuss_with: string; sensitivity: "direct" | "cross_person" | "unclear"; reason: string }>;
}

export const CONTEXT_ANALYSIS_VERSION = 5;

export function contextSourceHash(messages: AnalysisMessage[]): string {
  return createHash("sha256").update(JSON.stringify(messages.map((message) => [message.created_at ?? null, message.text])), "utf8").digest("hex");
}

export function contextAnalysisNeedsRefresh(analysis: ContextAnalysis | undefined, sourceId: string, sourceHash: string): boolean {
  return !analysis
    || analysis.analysisVersion !== CONTEXT_ANALYSIS_VERSION
    || analysis.sourceId !== sourceId
    || analysis.sourceHash !== sourceHash
    || analysis.status !== "ready";
}

export function splitContextMessages(messages: AnalysisMessage[], maxCharacters = 50_000): string[] {
  if (maxCharacters < 20) throw new Error("Context chunk size is too small");
  const chunks: string[] = [];
  let current = "";
  for (const [index, message] of messages.entries()) {
    const text = message.text.trim();
    if (!text) continue;
    const date = message.created_at && Number.isFinite(Date.parse(message.created_at)) ? new Date(message.created_at).toISOString() : "unknown";
    const header = `[${index + 1}; written_at=${date}] `;
    const numbered = header + text;
    if (current && current.length + numbered.length + 2 > maxCharacters) {
      chunks.push(current);
      current = "";
    }
    if (numbered.length <= maxCharacters) {
      current = current ? `${current}\n\n${numbered}` : numbered;
      continue;
    }
    if (current) { chunks.push(current); current = ""; }
    // Repeat provenance on fragments of a long pasted conversation.
    const fragmentHeader = header.length < maxCharacters - 4 ? header : `[${index + 1}] `;
    const size = maxCharacters - fragmentHeader.length;
    for (let offset = 0; offset < text.length; offset += size) chunks.push(fragmentHeader + text.slice(offset, offset + size));
  }
  if (current) chunks.push(current);
  return chunks;
}

export function normalizeContextAnalysis(raw: RawAnalysis, sourceId: string, sourceHash: string, previous?: ContextAnalysis, ownerName = "Вы"): ContextAnalysis {
  if (previous?.sourceId !== sourceId) previous = undefined;
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
  const used = new Set<string>(["owner", ...(previous?.people.map((person) => person.id) ?? [])]);
  const matched = new Set<string>();
  const keyToId = new Map<string, string>();
  const people = rawPeople.map((person, index) => {
    const base = person.key.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "") || `person-${index + 1}`;
    const names = new Set([person.label, ...person.aliases].map(normalizeName).filter(Boolean));
    const matches = previous?.people.filter((saved) => !matched.has(saved.id) && [saved.label, ...saved.aliases].some((name) => names.has(normalizeName(name)))) ?? [];
    const existing = matches.length === 1 ? matches[0] : undefined;
    let id = existing?.id ?? base;
    let suffix = 2;
    while (!existing && used.has(id)) id = `${base}-${suffix++}`;
    if (existing) matched.add(existing.id);
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
  return preserveContextAnalysis({ analysisVersion: CONTEXT_ANALYSIS_VERSION, sourceId, sourceHash, analyzedAt: new Date().toISOString(), status: "ready", people, portraits, topics }, previous);
}

/** Refresh adds discoveries, but never replaces a person's saved wording or consent. */
export function preserveContextAnalysis(incoming: ContextAnalysis, saved?: ContextAnalysis): ContextAnalysis {
  if (!saved || saved.sourceId !== incoming.sourceId) return incoming;
  const key = (title: string, person: string) => `${title.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase()}\0${person}`;
  const known = new Set(saved.topics.flatMap((topic) => [topic.title, ...(topic.sourceTitles ?? [])].map((title) => key(title, topic.discussWithPersonId))));
  const ids = new Set(saved.topics.map((topic) => topic.id));
  return { ...incoming,
    people: [...saved.people, ...incoming.people.filter((person) => !saved.people.some((old) => old.id === person.id))],
    portraits: [...(incoming.portraits ?? []), ...(saved.portraits ?? []).filter((portrait) => !incoming.portraits?.some((item) => item.personId === portrait.personId))],
    topics: [...saved.topics, ...incoming.topics.filter((topic) => !ids.has(topic.id) && !known.has(key(topic.title, topic.discussWithPersonId)))],
  };
}

/** Explicit rediscovery only. Ordinary sync still preserves every saved topic. */
export function replaceUnreviewedSuggestions(incoming: ContextAnalysis, saved: ContextAnalysis): ContextAnalysis {
  if (incoming.sourceId !== saved.sourceId) throw new Error("The selected source changed during rediscovery");
  const protectedTopics = saved.topics.filter((topic) => topic.approved || Boolean(topic.sourceTitles?.length));
  return preserveContextAnalysis({ ...incoming, topics: incoming.topics.map((topic) => ({ ...topic, approved: false })) }, { ...saved, topics: protectedTopics });
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

  async analyze(input: { sourceId: string; sourceHash: string; ownerName: string; language: string; messages: AnalysisMessage[]; previous?: ContextAnalysis; onProgress?: (progress: NonNullable<ContextAnalysis["progress"]>) => void | Promise<void> }): Promise<ContextAnalysis> {
    await mkdir(this.workspace, { recursive: true });
    const chunks = splitContextMessages(input.messages);
    if (!chunks.length) throw new Error("В выбранном чате нет текстовых реплик пользователя");
    const modelArgs = await preferredModelArgs(this.command);
    const sourceThrough = sourceThroughDate(input.messages);
    const total = chunks.length + 1;
    let completed = 0;
    const rawParts = await this.mapConcurrent(chunks, 2, async (transcript) => {
      // Historical extraction depends on the fragment, not the newest message in
      // another fragment. Only final selection decides what is current today.
      const prompt = buildDiscoveryPrompt(input.ownerName, input.language, transcript);
      const legacyPrompts = input.previous?.sourceThrough
        ? [buildDiscoveryPrompt(input.ownerName, input.language, transcript, input.previous.sourceThrough)] : [];
      const raw = await this.runCached(prompt, modelArgs, legacyPrompts);
      completed += 1;
      await input.onProgress?.({ stage: "analyzing", current: completed, total });
      return raw;
    });
    await input.onProgress?.({ stage: "consolidating", current: total, total });
    const raw = await this.consolidate(rawParts, input.ownerName, input.language, sourceThrough, modelArgs);
    return { ...normalizeContextAnalysis(raw, input.sourceId, input.sourceHash, input.previous, input.ownerName), model: modelArgs[1], sourceThrough };
  }

  private async consolidate(parts: RawAnalysis[], ownerName: string, language: string, sourceThrough: string | undefined, modelArgs: string[]): Promise<RawAnalysis> {
    const serialized = JSON.stringify(parts);
    if (serialized.length > 120_000 && parts.length > 2) {
      // Intermediate compaction must keep evidence, including resolved questions;
      // selecting topics here would discard later corrections before the final pass.
      const middle = Math.ceil(parts.length / 2);
      const compact = async (group: RawAnalysis[]) => this.runCached(
        buildDiscoveryPrompt(ownerName, language, "Research notes, retain dates, source references, corrections and unresolved questions: " + JSON.stringify(group), sourceThrough),
        modelArgs,
      );
      const compacted = await Promise.all([compact(parts.slice(0, middle)), compact(parts.slice(middle))]);
      return this.consolidate(compacted, ownerName, language, sourceThrough, modelArgs);
    }
    return this.runCached(buildTopicSelectionPrompt(parts, ownerName, language, sourceThrough), modelArgs);
  }

  private async runCached(prompt: string, modelArgs: string[], legacyPrompts: string[] = []): Promise<RawAnalysis> {
    const key = createHash("sha256").update(JSON.stringify({ prompt, modelArgs })).digest("hex");
    const file = path.join(this.workspace, `analysis-${key}.json`);
    try { return JSON.parse(await readFile(file, "utf8")) as RawAnalysis; }
    catch { /* a missing or invalid partial result is recalculated */ }
    // A one-time migration of v5 extraction notes with the same source fragment,
    // model and instructions, but the previous snapshot's date hint. Those notes
    // are evidence, not final topics; selection always rechecks the current date.
    let reusable: RawAnalysis | undefined;
    for (const legacyPrompt of legacyPrompts) {
      const legacyKey = createHash("sha256").update(JSON.stringify({ prompt: legacyPrompt, modelArgs })).digest("hex");
      try { reusable = JSON.parse(await readFile(path.join(this.workspace, `analysis-${legacyKey}.json`), "utf8")) as RawAnalysis; break; }
      catch { /* not the same historical fragment */ }
    }
    const result = reusable ?? await this.run(prompt, modelArgs);
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

  private async run(prompt: string, modelArgs: string[]): Promise<RawAnalysis> {
    const args = ["exec", ...modelArgs, "--ephemeral", "--skip-git-repo-check", "-s", "read-only", "--json", "--output-schema", this.schemaPath, "-C", this.workspace, "-"];
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, args, { cwd: this.workspace, shell: process.platform === "win32" && this.command.toLowerCase().endsWith(".cmd"), windowsHide: true });
      child.stdin.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") reject(error); });
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
