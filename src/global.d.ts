import type { ConversationReport } from "./core/types.js";

export interface AppState {
  owner: "dima" | "katya";
  autoStart: boolean;
  pendingTopics: string[];
  blockedTopics: string[];
  reports: string[];
  lastConversationAt?: string;
  running: boolean;
  codex: { installed: boolean; authenticated: boolean; version: string };
  remote: { configured: boolean; connected: boolean; pairId?: string; invite?: string };
}

declare global {
  interface Window {
    familyBridge?: {
      getState(): Promise<AppState>;
      runConversation(topic: string, realCodex: boolean): Promise<ConversationReport>;
      addTopic(topic: string): Promise<AppState>;
      blockTopic(topic: string): Promise<AppState>;
      setAutoStart(enabled: boolean): Promise<AppState>;
      openReports(): Promise<void>;
      createPair(): Promise<AppState>;
      joinPair(invite: string): Promise<AppState>;
      runRemote(topic: string): Promise<void>;
      onEvent(listener: (event: unknown) => void): () => void;
    };
  }
}

export {};
