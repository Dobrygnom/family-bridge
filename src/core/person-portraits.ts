import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type PortraitObservationKind = "fact" | "view" | "preference" | "pattern" | "uncertainty";
export type PortraitSourceType = "source_chat" | "conversation";

export interface PortraitObservation {
  id: string;
  kind: PortraitObservationKind;
  text: string;
  sourceType: PortraitSourceType;
  sourceId: string;
  sourceLabel?: string;
  updatedAt: string;
  userEdited?: boolean;
}

export interface PersonPortrait {
  personId: string;
  label: string;
  relationship: string;
  isOwner: boolean;
  observations: PortraitObservation[];
  updatedAt: string;
}

export interface RawPortrait {
  person_key: string;
  observations: Array<{ kind: PortraitObservationKind; text: string }>;
}

interface RawPortraitUpdates {
  updates: Array<{ person_id: string; observations: Array<{ kind: PortraitObservationKind; text: string }> }>;
}

const kinds = new Set<PortraitObservationKind>(["fact", "view", "preference", "pattern", "uncertainty"]);

function cleanText(value: unknown, maximum = 500) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, maximum) : "";
}

function observationKey(text: string) {
  return text.toLocaleLowerCase().replace(/[.,!?;:«»"'`()\[\]{}]/g, "").replace(/\s+/g, " ").trim();
}

function observationId(personId: string, sourceType: PortraitSourceType, sourceId: string, text: string) {
  return `portrait-${createHash("sha256").update(`${personId}\u0000${sourceType}\u0000${sourceId}\u0000${observationKey(text)}`).digest("hex").slice(0, 16)}`;
}

function sanitizeRawObservations(value: unknown) {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((entry): Array<{ kind: PortraitObservationKind; text: string }> => {
    if (!entry || typeof entry !== "object") return [];
    const raw = entry as { kind?: unknown; text?: unknown };
    if (!kinds.has(raw.kind as PortraitObservationKind)) return [];
    const text = cleanText(raw.text);
    const key = observationKey(text);
    if (!text || seen.has(key)) return [];
    seen.add(key);
    return [{ kind: raw.kind as PortraitObservationKind, text }];
  }).slice(0, 24);
}

export function buildInitialPortraits(input: {
  raw: RawPortrait[] | undefined;
  people: Array<{ personKey: string; personId: string; label: string; relationship: string; isOwner: boolean }>;
  sourceId: string;
  previous?: PersonPortrait[];
  now?: string;
}) {
  const now = input.now ?? new Date().toISOString();
  const previous = input.previous ?? [];
  return input.people.map((person) => {
    const raw = input.raw?.find((item) => item.person_key === person.personKey);
    const previousPortrait = previous.find((item) => item.personId === person.personId)
      ?? previous.find((item) => item.isOwner === person.isOwner && item.label.toLocaleLowerCase() === person.label.toLocaleLowerCase());
    const retained = previousPortrait?.observations.filter((item) => item.sourceType === "conversation" || item.userEdited) ?? [];
    const generated = sanitizeRawObservations(raw?.observations).map((item) => ({
      id: observationId(person.personId, "source_chat", input.sourceId, item.text),
      ...item,
      sourceType: "source_chat" as const,
      sourceId: input.sourceId,
      updatedAt: now,
    }));
    const retainedKeys = new Set(retained.map((item) => observationKey(item.text)));
    const observations = [...retained, ...generated.filter((item) => !retainedKeys.has(observationKey(item.text)))].slice(0, 40);
    return {
      personId: person.personId,
      label: cleanText(person.label, 100) || (person.isOwner ? "Вы" : "Человек"),
      relationship: cleanText(person.relationship, 100),
      isOwner: person.isOwner,
      observations,
      updatedAt: observations.length ? now : previousPortrait?.updatedAt ?? now,
    } satisfies PersonPortrait;
  });
}

export function applyPortraitUpdates(
  portraits: PersonPortrait[],
  raw: RawPortraitUpdates,
  source: { id: string; label: string; completedAt?: string },
) {
  const now = source.completedAt ?? new Date().toISOString();
  const allowed = new Set(portraits.map((item) => item.personId));
  const updates = Array.isArray(raw?.updates) ? raw.updates : [];
  return portraits.map((portrait) => {
    const matching = updates.filter((item) => item && allowed.has(item.person_id) && item.person_id === portrait.personId);
    const candidates = matching.flatMap((item) => sanitizeRawObservations(item.observations)).slice(0, 12);
    if (!candidates.length) return portrait;
    const existing = new Set(portrait.observations.map((item) => observationKey(item.text)));
    const additions = candidates.filter((item) => !existing.has(observationKey(item.text))).map((item) => ({
      id: observationId(portrait.personId, "conversation", source.id, item.text),
      ...item,
      sourceType: "conversation" as const,
      sourceId: source.id,
      sourceLabel: cleanText(source.label, 200),
      updatedAt: now,
    }));
    if (!additions.length) return portrait;
    return { ...portrait, observations: [...additions, ...portrait.observations].slice(0, 40), updatedAt: now };
  });
}

export function updatePortraitObservation(
  portraits: PersonPortrait[],
  input: { personId: string; observationId: string; text?: string; remove?: boolean },
  now = new Date().toISOString(),
) {
  let found = false;
  const text = input.remove ? "" : cleanText(input.text);
  if (!input.remove && !text) throw new Error("Введите суждение о человеке");
  const next = portraits.map((portrait) => {
    if (portrait.personId !== input.personId) return portrait;
    const observations = portrait.observations.flatMap((item): PortraitObservation[] => {
      if (item.id !== input.observationId) return [item];
      found = true;
      return input.remove ? [] : [{ ...item, text, updatedAt: now, userEdited: true }];
    });
    return found ? { ...portrait, observations, updatedAt: now } : portrait;
  });
  if (!found) throw new Error("Суждение не найдено");
  return next;
}

export class CodexPortraitUpdater {
  constructor(private readonly command: string, private readonly workspace: string, private readonly schemaPath: string) {}

  async update(input: {
    portraits: PersonPortrait[];
    participants: Array<{ personId: string; label: string }>;
    topic: string;
    conversationId: string;
    messages: Array<{ personId: string; speaker: string; text: string }>;
    language: string;
    completedAt?: string;
  }) {
    if (!input.participants.length || !input.messages.length) return input.portraits;
    await mkdir(this.workspace, { recursive: true });
    const existing = input.portraits.filter((portrait) => input.participants.some((person) => person.personId === portrait.personId))
      .map((portrait) => ({ person_id: portrait.personId, observations: portrait.observations.map(({ kind, text }) => ({ kind, text })) }));
    const transcript = input.messages.map((message, index) => `[${index + 1}] ${message.speaker} (${message.personId}): ${message.text}`).join("\n\n");
    const prompt = `Обнови локальные портреты конкретных людей после завершённого разговора их агентов.

Извлекай только новое знание о самих участниках: факты, прямо высказанные взгляды, предпочтения, устойчивые способы реагирования и честно обозначенную неопределённость. Не создавай отдельный портрет отношений или пары. Не превращай одно случайное слово в черту характера, не ставь диагнозов и не выдавай предположение за факт. Используй только то, что действительно следует из видимых реплик. Не повторяй уже сохранённые суждения. Если нового знания о человеке нет, верни для него пустой список или не включай его в updates.

Допустимые kind:
- fact — конкретный факт о человеке;
- view — его прямо выраженная позиция или объяснение;
- preference — его желание, потребность или граница;
- pattern — явно описанный или подтверждённый повторяющийся способ поведения;
- uncertainty — существенная неопределённость самого человека.

Пиши суждения коротко, самостоятельно и на языке ${input.language}. Не копируй интимные реплики дословно. person_id должен быть только из списка участников.

Участники:
${JSON.stringify(input.participants)}

Уже сохранено:
${JSON.stringify(existing)}

Тема: ${input.topic}

Разговор:
${transcript}

Верни только JSON по схеме.`;
    const raw = await this.runCached(prompt);
    return applyPortraitUpdates(input.portraits, raw, { id: input.conversationId, label: input.topic, completedAt: input.completedAt });
  }

  private async runCached(prompt: string): Promise<RawPortraitUpdates> {
    const key = createHash("sha256").update(prompt).digest("hex");
    const file = path.join(this.workspace, `portrait-${key}.json`);
    try { return JSON.parse(await readFile(file, "utf8")) as RawPortraitUpdates; }
    catch { /* missing or invalid output is recalculated */ }
    const result = await this.run(prompt);
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(result), "utf8");
    await rename(temporary, file);
    return result;
  }

  private run(prompt: string): Promise<RawPortraitUpdates> {
    const args = ["exec", "--ephemeral", "--skip-git-repo-check", "-s", "read-only", "--json", "--output-schema", this.schemaPath, "-C", this.workspace, "-"];
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, args, { cwd: this.workspace, shell: process.platform === "win32" && this.command.toLowerCase().endsWith(".cmd"), windowsHide: true });
      child.stdin.end(prompt);
      const timeout = setTimeout(() => { child.kill(); reject(new Error("Codex portrait update timed out")); }, 15 * 60_000);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      child.on("close", (code) => {
        clearTimeout(timeout);
        if (code !== 0) { reject(new Error(`Codex portrait update exited with ${code}: ${stderr || stdout}`)); return; }
        try {
          let finalText = "";
          for (const line of stdout.split(/\r?\n/)) {
            if (!line.trim().startsWith("{")) continue;
            const event = JSON.parse(line) as { type?: string; item?: { type?: string; text?: string }; message?: string };
            if (event.type === "item.completed" && event.item?.type === "agent_message") finalText = event.item.text ?? "";
            if (event.type === "error") throw new Error(event.message ?? "Codex portrait update failed");
          }
          if (!finalText) throw new Error(`Codex did not return portrait updates. ${stderr}`);
          resolve(JSON.parse(finalText) as RawPortraitUpdates);
        } catch (error) { reject(error); }
      });
    });
  }
}
