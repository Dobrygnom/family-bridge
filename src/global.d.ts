import type { ConversationReport } from "./core/types.js";

export interface AppState {
  owner: "dima" | "katya";
  identityConfigured: boolean;
  language: "ru" | "en" | "cs" | "fr";
  autoStart: boolean;
  pendingTopics: string[];
  blockedTopics: string[];
  reports: string[];
  lastConversationAt?: string;
  running: boolean;
  codex: { installed: boolean; authenticated: boolean; version: string };
  remote: { configured: boolean; connected: boolean; pairId?: string; invite?: string };
  memory: { configured: boolean; messageCount: number; lastCheckedAt?: string; status?: string };
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
      setOwner(owner: "dima" | "katya"): Promise<AppState>;
      setLanguage(language: "ru" | "en" | "cs" | "fr"): Promise<AppState>;
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
