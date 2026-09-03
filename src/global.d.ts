import type { ConversationReport } from "./core/types.js";
import type { DictationResult } from "./core/dictation.js";
import type { PeerVersionCheck } from "./core/peer-version.js";
import type { LiveConversation } from "./core/conversation-updates.js";

export interface AppState {
  owner: "dima" | "katya";
  onboardingComplete: boolean;
  identityConfigured: boolean;
  displayName: string;
  language: "ru" | "en" | "cs" | "fr";
  autoStart: boolean;
  appVersion: string;
  pendingTopics: string[];
  pairTopics: string[];
  topicSources: Record<string, Array<"local" | "peer" | "unknown">>;
  activeTopics: string[];
  blockedTopics: string[];
  reports: string[];
  reportSummaries: Array<{ id: string; parentReportId?: string; topic: string; summary: string; answerFrom: string; proposedBy: string[]; localPosition?: string; peerPosition?: string; comparison?: string; completedAt: string; messageCount: number; messages: Array<{ speaker: string; text: string; local: boolean }> }>;
  ownerQuestions: Array<{ id: string; topic: string; question: string; createdAt: string; peerName?: string }>;
  continuationStates?: Array<{ id: string; parentReportId: string; status: "starting" | "waiting" | "complete" | "error" }>;
  conversationRevision?: number;
  liveConversations?: LiveConversation[];
  lastConversationAt?: string;
  running: boolean;
  contextSyncing: boolean;
  contextSyncProgress: number;
  codex: { installed: boolean; authenticated: boolean; version: string };
  remote: { configured: boolean; connected: boolean; pairId?: string; invite?: string; peerName?: string; peerVersion?: string; peerLastSeenAt?: string; peerVersionCheck?: PeerVersionCheck; counterpartPersonId?: string; counterpartLabel?: string };
  memory: { configured: boolean; messageCount: number; learnedCount: number; lastCheckedAt?: string; status?: string };
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
  update: { available: boolean; version?: string; checking?: boolean; downloading: boolean; progress?: number; ready?: boolean; error?: string };
}

declare global {
  interface Window {
    familyBridge?: {
      getState(): Promise<AppState>;
      diagnoseUi(input: { onboardingComplete: boolean; analysisStatus?: string }): Promise<void>;
      openDiagnostics(): Promise<void>;
      getLocalContextState(): Promise<Pick<AppState, "context" | "contextAnalysis">>;
      runConversation(topic: string, realCodex: boolean): Promise<ConversationReport>;
      addTopic(topic: string): Promise<AppState>;
      blockTopic(topic: string): Promise<AppState>;
      setAutoStart(enabled: boolean): Promise<AppState>;
      setDisplayName(name: string): Promise<AppState>;
      setLanguage(language: "ru" | "en" | "cs" | "fr"): Promise<AppState>;
      listContextThreads(): Promise<Array<{ id: string; title: string; project: string; source: "codex" | "chatgpt"; cwd?: string; updatedAt?: number }>>;
      selectContextThread(threadId: string): Promise<AppState>;
      syncContext(): Promise<AppState>;
      refreshContextNow(): Promise<AppState>;
      completeOnboarding(): Promise<AppState>;
      openReports(): Promise<void>;
      createPair(counterpartPersonId: string): Promise<AppState>;
      joinPair(invite: string, counterpartPersonId: string): Promise<AppState>;
      updateContextTopic(input: { topicId: string; aboutPersonIds?: string[]; discussWithPersonId?: string; approved?: boolean }): Promise<AppState>;
      updateContextTopics(input: { topicIds: string[]; approved: boolean }): Promise<AppState>;
      runRemote(topic: string): Promise<void>;
      discussAllTopics(): Promise<AppState>;
      continueReport(input: { reportId: string; requestId: string; prompt: string }): Promise<AppState>;
      retryContinuation(id: string): Promise<AppState>;
      answerOwnerQuestion(input: { id: string; disposition: "answer" | "unknown" | "decline"; answer?: string }): Promise<AppState>;
      requestMicrophone(): Promise<boolean>;
      transcribeAudio(input: { id: string; audio: Uint8Array }): Promise<DictationResult>;
      cancelDictation(id: string): Promise<void>;
      checkForUpdates(): Promise<void>;
      checkPairVersions(): Promise<AppState>;
      installUpdate(): Promise<void>;
      onEvent(listener: (event: unknown) => void): () => void;
    };
  }
}

export {};
