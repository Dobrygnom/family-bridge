import type { ConversationReport } from "./core/types.js";

export interface AppState {
  owner: "dima" | "katya";
  identityConfigured: boolean;
  displayName: string;
  language: "ru" | "en" | "cs" | "fr";
  autoStart: boolean;
  pendingTopics: string[];
  blockedTopics: string[];
  reports: string[];
  lastConversationAt?: string;
  running: boolean;
  codex: { installed: boolean; authenticated: boolean; version: string };
  remote: { configured: boolean; connected: boolean; pairId?: string; invite?: string; peerName?: string };
  memory: { configured: boolean; messageCount: number; lastCheckedAt?: string; status?: string };
  context?: { id: string; title: string; project: string; cwd?: string; updatedAt?: number; lastSyncedAt?: string; messageCount?: number; status?: "ready" | "syncing" | "error"; error?: string };
  update: { available: boolean; version?: string; downloading: boolean };
}

declare global {
  interface Window {
    familyBridge?: {
      getState(): Promise<AppState>;
      runConversation(topic: string, realCodex: boolean): Promise<ConversationReport>;
      addTopic(topic: string): Promise<AppState>;
      blockTopic(topic: string): Promise<AppState>;
      setAutoStart(enabled: boolean): Promise<AppState>;
      setDisplayName(name: string): Promise<AppState>;
      setLanguage(language: "ru" | "en" | "cs" | "fr"): Promise<AppState>;
      listContextThreads(): Promise<Array<{ id: string; title: string; project: string; cwd?: string; updatedAt?: number }>>;
      selectContextThread(threadId: string): Promise<AppState>;
      syncContext(): Promise<AppState>;
      openReports(): Promise<void>;
      createPair(): Promise<AppState>;
      joinPair(invite: string): Promise<AppState>;
      runRemote(topic: string): Promise<void>;
      checkForUpdates(): Promise<void>;
      onEvent(listener: (event: unknown) => void): () => void;
    };
  }
}

export {};
