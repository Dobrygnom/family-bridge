import { useCallback, useEffect, useRef, useState } from "react";
import type { AppState } from "../global.js";
import { conversationThreads } from "../core/conversation-threads.js";
import { initialReadingState, mergeReadingState, parseReadingState, READING_KEY, unreadMessages, type ReadingState } from "../core/conversation-attention.js";

export function useConversationReading(state: AppState, loaded: boolean, notify?: (threadId: string) => Promise<void>, setSystemUnreadCount?: (count: number) => Promise<void>, saveReading?: (reading: ReadingState) => Promise<void>) {
  const [reading, setReading] = useState(() => { try { return parseReadingState(localStorage.getItem(READING_KEY)); } catch { return undefined; } });
  const current = useRef(reading);
  const [saveFailed, setSaveFailed] = useState(false);
  const commit = useCallback((next: ReadingState) => {
    const stamped = { ...next, updatedAt: new Date().toISOString() };
    try { localStorage.setItem(READING_KEY, JSON.stringify(stamped)); current.current = stamped; setReading(stamped); setSaveFailed(false); void saveReading?.(stamped).catch(() => setSaveFailed(true)); return true; }
    catch { setSaveFailed(true); return false; }
  }, [saveReading]);
  useEffect(() => {
    if (!loaded) return;
    const merged = mergeReadingState(current.current, state.conversationReading);
    if (!merged) return;
    const changed = JSON.stringify(merged) !== JSON.stringify(current.current);
    if (changed) { current.current = merged; setReading(merged); try { localStorage.setItem(READING_KEY, JSON.stringify(merged)); } catch { setSaveFailed(true); } }
    if (!state.conversationReading || changed) void saveReading?.(merged).catch(() => setSaveFailed(true));
  }, [loaded, state.conversationReading, saveReading]);
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
  const threads = conversationThreads(state);
  const unreadCount = threads.filter(thread => unreadMessages(thread, reading).length > 0).length;
  const unreadMessageCount = threads.reduce((count, thread) => count + unreadMessages(thread, reading).length, 0);
  useEffect(() => {
    if (loaded) void setSystemUnreadCount?.(unreadMessageCount).catch(() => undefined);
  }, [loaded, unreadMessageCount, setSystemUnreadCount]);
  return { reading, markRead, unreadCount, unreadMessageCount, saveFailed };
}
