import type { conversationThreads } from "./conversation-threads.js";

export type ConversationThread = ReturnType<typeof conversationThreads>[number];
export interface ReadingState { version: 1; seen: Record<string, true>; notifiedStages: string[] }
export const READING_KEY = "family-bridge-reading-v1";

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
    return { version: 1, seen: Object.fromEntries(Object.entries(parsed.seen).filter(([, value]) => value === true).map(([key]) => [key, true as const])),
      notifiedStages: parsed.notifiedStages.filter((id: unknown): id is string => typeof id === "string") };
  } catch { return undefined; }
}

export const attentionLabels = {
  ru: { new: "Новое", since: "С вашего последнего просмотра", jump: "Новые сообщения", saveError: "Не удалось сохранить отметки прочитанного. Новые сообщения остаются отмеченными." },
  en: { new: "New", since: "Since your last visit", jump: "New messages", saveError: "Could not save reading progress. New messages remain marked." },
  cs: { new: "Nové", since: "Od posledního přečtení", jump: "Nové zprávy", saveError: "Průběh čtení se nepodařilo uložit. Nové zprávy zůstávají označené." },
  fr: { new: "Nouveau", since: "Depuis votre dernière lecture", jump: "Nouveaux messages", saveError: "Impossible d’enregistrer la lecture. Les nouveaux messages restent marqués." },
};
