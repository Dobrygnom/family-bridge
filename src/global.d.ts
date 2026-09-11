import type { ConversationReport } from "./core/types.js";
import type { DictationResult } from "./core/dictation.js";
import type { PeerVersionCheck } from "./core/peer-version.js";
import type { LiveConversation } from "./core/conversation-updates.js";
import type { TopicBrief } from "./core/conversation-quality.js";
import type { PersonPortrait } from "./core/person-portraits.js";
import type { RoutedTopic } from "./core/context-analysis.js";

export interface AppState {
  owner: "dima" | "katya";
  onboardingComplete: boolean;
  identityConfigured: boolean;
  preferredCounterpartPersonId?: string;
  displayName: string;
  language: "ru" | "en" | "cs" | "fr";
  autoStart: boolean;
  appVersion: string;
  pendingTopics: string[];
  pairTopics: string[];
  topicSources: Record<string, Array<"local" | "peer" | "unknown">>;
  topicBriefs: Record<string, TopicBrief>;
  activeTopics: string[];
  topicLaunches?: Record<string, { topic: string; pairId: string }>;
  blockedTopics: string[];
  reports: string[];
  reportSummaries: Array<{ id: string; parentReportId?: string; restarted?: boolean; inheritedMessageCount?: number; topic: string; summary: string; answerFrom: string; proposedBy: string[]; localPosition?: string; peerPosition?: string; comparison?: string; completionState?: "completed" | "needs_follow_up"; completedAt: string; messageCount: number; messages: Array<{ speaker: string; text: string; local: boolean; origin?: import("./core/continuation.js").MessageOrigin }> }>;
  ownerQuestions: Array<{ id: string; topic: string; question: string; createdAt: string; peerName?: string }>;
  continuationStates?: Array<{ id: string; parentReportId: string; mode?: "restart" | "clean-continuation"; status: "starting" | "waiting" | "complete" | "error" }>;
  conversationRevision?: number;
  repairPendingIds?: string[];
  repairWaiting?: Record<string, "peer" | "version" | "active" | "queued">;
  liveConversations?: LiveConversation[];
  lastConversationAt?: string;
  running: boolean;
  contextSyncing: boolean;
  contextSyncProgress: number;
  portraitsUpdating: boolean;
  codex: { installed: boolean; authenticated: boolean; version: string };
  remote: { configured: boolean; connected: boolean; dialogueCompatible?: boolean; pairId?: string; invite?: string; peerName?: string; peerVersion?: string; peerExperienceVersion?: string; peerLastSeenAt?: string; peerPresenceAt?: string; peerVersionCheck?: PeerVersionCheck; counterpartPersonId?: string; counterpartLabel?: string };
  memory: { configured: boolean; messageCount: number; learnedCount: number; lastCheckedAt?: string; status?: string };
  context?: { id: string; title: string; project: string; source?: "codex" | "chatgpt"; cwd?: string; updatedAt?: number; lastSyncedAt?: string; messageCount?: number; status?: "ready" | "syncing" | "error" | "confirmation"; error?: string };
  contextAnalysis?: {
    analysisVersion: number;
    sourceId: string;
    sourceHash: string;
    analyzedAt: string;
    status: "ready" | "analyzing" | "error";
    error?: string;
    progress?: { stage: "analyzing" | "consolidating"; current: number; total: number };
    people: Array<{ id: string; label: string; relationship: string; aliases: string[] }>;
    portraits?: PersonPortrait[];
    topics: RoutedTopic[];
  };
  update: { available: boolean; version?: string; checking?: boolean; downloading: boolean; progress?: number; ready?: boolean; error?: string; installRequested?: boolean; installing?: boolean; waitingFor?: "activity" | "dictation" | "editing" | "background" };
}

declare global {
  interface Window {
    familyBridge?: {
      getState(): Promise<AppState>;
      notifyConversation(threadId: string): Promise<void>;
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
      updatePortraitObservation(input: { personId: string; observationId: string; text?: string; remove?: boolean }): Promise<AppState>;
      completeOnboarding(counterpartPersonId?: string): Promise<AppState>;
      openReports(): Promise<void>;
      createPair(counterpartPersonId: string): Promise<AppState>;
      joinPair(invite: string, counterpartPersonId: string): Promise<AppState>;
      updateContextTopic(input: { topicId: string; aboutPersonIds?: string[]; discussWithPersonId?: string; approved?: boolean; dismissed?: boolean; title?: string; context?: string; goal?: string; openingQuestion?: string }): Promise<AppState>;
      refineContextTopic(input: { topicId: string; instruction: string; preview?: { title: string; context: string; goal: string; openingQuestion: string } }): Promise<{ title: string; context: string; goal: string; openingQuestion: string }>;
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
      setUpdateBlocked(blocked: boolean, reason?: "dictation" | "editing" | "activity"): Promise<void>;
      checkPairVersions(): Promise<AppState>;
      installUpdate(): Promise<void>;
      onEvent(listener: (event: unknown) => void): () => void;
    };
  }
}

export {};
