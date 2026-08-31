import type { ConversationReport } from "./core/types.js";

export interface AppState {
  owner: "dima" | "katya";
  onboardingComplete: boolean;
  identityConfigured: boolean;
  displayName: string;
  language: "ru" | "en" | "cs" | "fr";
  autoStart: boolean;
  pendingTopics: string[];
  blockedTopics: string[];
  reports: string[];
  ownerQuestions: Array<{ id: string; topic: string; question: string; createdAt: string; peerName?: string }>;
  lastConversationAt?: string;
  running: boolean;
  contextSyncing: boolean;
  contextSyncProgress: number;
  codex: { installed: boolean; authenticated: boolean; version: string };
  remote: { configured: boolean; connected: boolean; pairId?: string; invite?: string; peerName?: string; counterpartPersonId?: string; counterpartLabel?: string };
  memory: { configured: boolean; messageCount: number; lastCheckedAt?: string; status?: string };
  context?: { id: string; title: string; project: string; source?: "codex" | "chatgpt"; cwd?: string; updatedAt?: number; lastSyncedAt?: string; messageCount?: number; status?: "ready" | "syncing" | "error"; error?: string };
  contextAnalysis?: {
    analysisVersion: number;
    sourceId: string;
    sourceHash: string;
    analyzedAt: string;
    status: "ready" | "analyzing" | "error";
    error?: string;
    progress?: { stage: "analyzing" | "consolidating"; current: number; total: number };
    people: Array<{ id: string; label: string; relationship: string; aliases: string[] }>;
    topics: Array<{ id: string; title: string; aboutPersonIds: string[]; discussWithPersonId: string; sensitivity: "direct" | "cross_person" | "unclear"; reason: string; approved: boolean }>;
  };
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
      listContextThreads(): Promise<Array<{ id: string; title: string; project: string; source: "codex" | "chatgpt"; cwd?: string; updatedAt?: number }>>;
      selectContextThread(threadId: string): Promise<AppState>;
      syncContext(): Promise<AppState>;
      completeOnboarding(): Promise<AppState>;
      openReports(): Promise<void>;
      createPair(counterpartPersonId: string): Promise<AppState>;
      joinPair(invite: string, counterpartPersonId: string): Promise<AppState>;
      updateContextTopic(input: { topicId: string; aboutPersonIds?: string[]; discussWithPersonId?: string; approved?: boolean }): Promise<AppState>;
      updateContextTopics(input: { topicIds: string[]; approved: boolean }): Promise<AppState>;
      runRemote(topic: string): Promise<void>;
      discussAllTopics(): Promise<AppState>;
      answerOwnerQuestion(input: { id: string; disposition: "answer" | "unknown" | "decline"; answer?: string }): Promise<AppState>;
      checkForUpdates(): Promise<void>;
      onEvent(listener: (event: unknown) => void): () => void;
    };
  }
}

export {};
