import type { conversationThreads } from "./conversation-threads.js";

export type ConversationThread = ReturnType<typeof conversationThreads>[number];
export interface ReadingState { version: 1; seen: Record<string, true>; notifiedStages: string[]; updatedAt?: string }
export interface ReadingReceiptSnapshot { version: 1; updatedAt: string; stages: Record<string, Array<[number, number]>> }
export const READING_KEY = "family-bridge-reading-v1";
const stageId = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9-]{1,100}$/i.test(value);
const iso = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

// Reading requires continuous visibility in a focused window, not an arrival
// event or merely opening the list. The injected timer makes this testable.
export function readingReceipt(markRead: () => void, schedule: (action: () => void) => () => void) {
  let cancel: (() => void) | undefined, eligible = false, done = false;
  return {
    update(visible: boolean, focused: boolean) {
      const next = visible && focused;
      if (done || next === eligible) return;
      eligible = next;
      cancel?.(); cancel = undefined;
      if (eligible) cancel = schedule(() => { if (eligible && !done) { done = true; markRead(); } });
    },
    dispose() { eligible = false; cancel?.(); },
  };
}

export function threadMessages(thread: ConversationThread) {
  return thread.currentStages.flatMap(stage => stage.newMessages.map((message, index) => ({
    ...message, stageId: stage.id,
    // Absolute transcript offsets survive inherited-prefix removal and live -> report.
    key: `${stage.id}:${stage.messages.length - stage.newMessages.length + index}`,
  })));
}
export function unreadMessages(thread: ConversationThread, reading?: ReadingState) {
  return reading ? threadMessages(thread).filter(message => !reading.seen[message.key]) : [];
}
export function initialReadingState(threads: ConversationThread[]): ReadingState {
  return { version: 1, seen: Object.fromEntries(threads.flatMap(threadMessages).map(message => [message.key, true as const])),
    notifiedStages: threads.flatMap(thread => thread.currentStages.map(stage => stage.id)) };
}
export function parseReadingState(value: string | null): ReadingState | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (parsed?.version !== 1 || !parsed.seen || Array.isArray(parsed.seen) || typeof parsed.seen !== "object" || !Array.isArray(parsed.notifiedStages)) return undefined;
    const seen = Object.entries(parsed.seen).filter(([key, value]) => value === true && /^([a-z0-9-]{1,100}):(\d{1,6})$/i.test(key)).slice(0, 20_000);
    return { version: 1, seen: Object.fromEntries(seen.map(([key]) => [key, true as const])),
      notifiedStages: [...new Set<string>(parsed.notifiedStages.filter((id: unknown): id is string => stageId(id)))].slice(0, 2_000), ...(iso(parsed.updatedAt) ? { updatedAt: parsed.updatedAt } : {}) };
  } catch { return undefined; }
}

export function mergeReadingState(a: ReadingState | undefined, b: ReadingState | undefined): ReadingState | undefined {
  if (!a) return b;
  if (!b) return a;
  const updatedAt = [a.updatedAt, b.updatedAt].filter(iso).sort().at(-1);
  return { version: 1, seen: Object.fromEntries(Object.entries({ ...a.seen, ...b.seen }).slice(-20_000)), notifiedStages: [...new Set([...a.notifiedStages, ...b.notifiedStages])].slice(-2_000), ...(updatedAt ? { updatedAt } : {}) };
}

export function readingReceiptSnapshot(reading: ReadingState | undefined, now = new Date().toISOString()): ReadingReceiptSnapshot | undefined {
  if (!reading) return;
  const stages: ReadingReceiptSnapshot["stages"] = {};
  const keys = Object.keys(reading.seen).flatMap(key => {
    const match = key.match(/^([a-z0-9-]{1,100}):(\d{1,6})$/i);
    return match ? [{ key, stage: match[1], index: Number(match[2]) }] : [];
  }).sort((a, b) => a.stage.localeCompare(b.stage) || a.index - b.index);
  for (const { stage, index } of keys) {
    const indexes = stages[stage] ??= [];
    const last = indexes.at(-1);
    if (last && index >= last[0] && index <= last[1] + 1) last[1] = Math.max(last[1], index);
    else indexes.push([index, index]);
  }
  return { version: 1, updatedAt: reading.updatedAt && iso(reading.updatedAt) ? reading.updatedAt : now, stages };
}

export function sanitizeReadingReceiptSnapshot(value: unknown): ReadingReceiptSnapshot | undefined {
  const input = value as ReadingReceiptSnapshot | null;
  if (!input || input.version !== 1 || !iso(input.updatedAt) || !input.stages || typeof input.stages !== "object" || Array.isArray(input.stages)) return;
  const stages: ReadingReceiptSnapshot["stages"] = {};
  let ranges = 0;
  for (const [id, raw] of Object.entries(input.stages).slice(0, 500)) {
    if (!stageId(id) || !Array.isArray(raw)) return;
    const safe: Array<[number, number]> = [];
    for (const range of raw) {
      if (!Array.isArray(range) || range.length !== 2 || !range.every(index => Number.isSafeInteger(index) && index >= 0 && index <= 1_000_000) || range[0] > range[1] || ++ranges > 5_000) return;
      safe.push([range[0], range[1]]);
    }
    stages[id] = safe;
  }
  return { version: 1, updatedAt: input.updatedAt, stages };
}

export function readingReceiptSeen(snapshot: ReadingReceiptSnapshot | undefined, key: string) {
  const match = key.match(/^([a-z0-9-]{1,100}):(\d{1,6})$/i);
  if (!snapshot || !match) return false;
  const index = Number(match[2]);
  return (snapshot.stages[match[1]] ?? []).some(([start, end]) => index >= start && index <= end);
}

export const attentionLabels = {
  ru: { new: "Новое", since: "С вашего последнего просмотра", jump: "Новые сообщения", saveError: "Не удалось сохранить отметки прочитанного. Новые сообщения остаются отмеченными." },
  en: { new: "New", since: "Since your last visit", jump: "New messages", saveError: "Could not save reading progress. New messages remain marked." },
  cs: { new: "Nové", since: "Od posledního přečtení", jump: "Nové zprávy", saveError: "Průběh čtení se nepodařilo uložit. Nové zprávy zůstávají označené." },
  fr: { new: "Nouveau", since: "Depuis votre dernière lecture", jump: "Nouveaux messages", saveError: "Impossible d’enregistrer la lecture. Les nouveaux messages restent marqués." },
};
