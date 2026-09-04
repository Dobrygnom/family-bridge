import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TopicBrief } from "../src/core/conversation-quality.js";

export type OwnerId = "dima" | "katya";
export type AppLanguage = "ru" | "en" | "cs" | "fr";
export type OwnerQuestionDisposition = "answer" | "unknown" | "decline";
export type TopicSource = "local" | "peer" | "unknown";
export interface ConversationContinuation {
  parentReportId: string;
  topic: string;
  pairId: string;
  instruction: string;
  history: Array<{ from: OwnerId; text: string }>;
  status: "starting" | "waiting" | "complete" | "error";
  preparedMessage?: string;
}

export interface PendingOwnerQuestion {
  id: string;
  conversationId: string;
  topic: string;
  question: string;
  createdAt: string;
  peerName?: string;
  nextSequence: number;
  transcript: Array<{ from: OwnerId; text: string }>;
}

export interface StoredState {
  owner: OwnerId;
  onboardingComplete: boolean;
  identityConfigured: boolean;
  preferredCounterpartPersonId?: string;
  displayName: string;
  language: AppLanguage;
  autoStart: boolean;
  pendingTopics: string[];
  inFlightTopics: string[];
  pairTopics: string[];
  topicSources: Record<string, TopicSource[]>;
  topicBriefs: Record<string, TopicBrief>;
  topicSourceMigrationVersion?: string;
  activeTopics: string[];
  blockedTopics: string[];
  reports: string[];
  pendingOwnerQuestions: PendingOwnerQuestion[];
  conversationTranscripts: Record<string, { topic: string; messages: Array<{ from: OwnerId; text: string }> }>;
  conversationResetVersion?: string;
  conversationResetAt?: string;
  experienceResetVersion?: string;
  experienceResetAt?: string;
  ignoredConversationIds: string[];
  continuations: Record<string, ConversationContinuation>;
  conversationParents: Record<string, string>;
  lastConversationAt?: string;
  remote?: {
    pairId: string;
    encryptionSecret: string;
    inviteSecret?: string;
    peerName?: string;
    peerVersion?: string;
    peerExperienceVersion?: string;
    peerLastSeenAt?: string;
    counterpartPersonId?: string;
  };
}

const defaults: StoredState = {
  owner: "dima",
  onboardingComplete: false,
  identityConfigured: false,
  displayName: "",
  language: "ru",
  autoStart: true,
  pendingTopics: [],
  inFlightTopics: [],
  pairTopics: [],
  topicSources: {},
  topicBriefs: {},
  activeTopics: [],
  blockedTopics: [],
  reports: [],
  pendingOwnerQuestions: [],
  conversationTranscripts: {},
  ignoredConversationIds: [],
  continuations: {},
  conversationParents: {},
};

export class AtomicStore {
  private readonly file: string;
  private pending: Promise<void> = Promise.resolve();

  constructor(directory: string) {
    this.file = path.join(directory, "state.json");
  }

  async read(): Promise<StoredState> {
    await this.pending;
    return this.readSnapshot();
  }

  private async readSnapshot(): Promise<StoredState> {
    try {
      const value = JSON.parse(await readFile(this.file, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid saved state");
      return { ...defaults, ...value };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(defaults);
      // A broken/unreadable file is NOT a new installation. Never overwrite it
      // with defaults on the next settings change.
      throw new Error("Не удалось прочитать сохранённое состояние. Данные не сброшены. Закройте приложение и повторите запуск.");
    }
  }

  update(update: Partial<StoredState>): Promise<StoredState> {
    return this.mutate(() => update);
  }

  mutate(update: (current: StoredState) => Partial<StoredState>): Promise<StoredState> {
    const operation = this.pending.then(async () => {
      const current = await this.readSnapshot();
      const next = { ...current, ...update(current) };
      await mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.tmp`;
      await writeFile(temporary, JSON.stringify(next, null, 2), "utf8");
      await rename(temporary, this.file);
      return next;
    });
    this.pending = operation.then(() => undefined, () => undefined);
    return operation;
  }
}
