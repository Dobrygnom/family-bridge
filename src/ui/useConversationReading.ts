import { useCallback, useEffect, useRef, useState } from "react";
import type { AppState } from "../global.js";
import { conversationThreads } from "../core/conversation-threads.js";
import { initialReadingState, parseReadingState, READING_KEY, unreadMessages, type ReadingState } from "../core/conversation-attention.js";

export function useConversationReading(state: AppState, loaded: boolean, notify?: (threadId: string) => Promise<void>) {
  const [reading, setReading] = useState(() => { try { return parseReadingState(localStorage.getItem(READING_KEY)); } catch { return undefined; } });
  const current = useRef(reading);
  const [saveFailed, setSaveFailed] = useState(false);
  const commit = useCallback((next: ReadingState) => {
    try { localStorage.setItem(READING_KEY, JSON.stringify(next)); current.current = next; setReading(next); setSaveFailed(false); return true; }
    catch { setSaveFailed(true); return false; }
  }, []);
  useEffect(() => {
    if (!loaded) return;
    const threads = conversationThreads(state);
    if (!current.current) { commit(initialReadingState(threads)); return; }
    if (document.visibilityState === "visible" && document.hasFocus()) return;
    const notified = new Set(current.current.notifiedStages);
    const pending = threads.flatMap(thread => {
      const stages = [...new Set(unreadMessages(thread, current.current).filter(message => !message.local && !notified.has(message.stageId)).map(message => message.stageId))];
      stages.forEach(id => notified.add(id));
      return stages.length ? [thread.id] : [];
    });
    if (pending.length && commit({ ...current.current, notifiedStages: [...notified] })) pending.forEach(id => void notify?.(id).catch(() => undefined));
  }, [state, loaded, commit, notify]);
  const markRead = useCallback((keys: string[]) => {
    if (!current.current || !keys.some(key => !current.current!.seen[key])) return;
    commit({ ...current.current, seen: { ...current.current.seen, ...Object.fromEntries(keys.map(key => [key, true as const])) } });
  }, [commit]);
  const unreadCount = conversationThreads(state).filter(thread => unreadMessages(thread, reading).length > 0).length;
  return { reading, markRead, unreadCount, saveFailed };
}
