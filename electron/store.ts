import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type OwnerId = "dima" | "katya";
export type AppLanguage = "ru" | "en" | "cs" | "fr";
export type OwnerQuestionDisposition = "answer" | "unknown" | "decline";
export type TopicSource = "local" | "peer" | "unknown";

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
  displayName: string;
  language: AppLanguage;
  autoStart: boolean;
  pendingTopics: string[];
  inFlightTopics: string[];
  pairTopics: string[];
  topicSources: Record<string, TopicSource[]>;
  topicSourceMigrationVersion?: string;
  activeTopics: string[];
  blockedTopics: string[];
  reports: string[];
  pendingOwnerQuestions: PendingOwnerQuestion[];
  conversationTranscripts: Record<string, { topic: string; messages: Array<{ from: OwnerId; text: string }> }>;
  conversationResetVersion?: string;
  conversationResetAt?: string;
  ignoredConversationIds: string[];
  lastConversationAt?: string;
  remote?: {
    pairId: string;
    encryptionSecret: string;
    inviteSecret?: string;
    peerName?: string;
    peerVersion?: string;
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
  activeTopics: [],
  blockedTopics: [],
  reports: [],
  pendingOwnerQuestions: [],
  conversationTranscripts: {},
  ignoredConversationIds: [],
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
      return { ...defaults, ...JSON.parse(await readFile(this.file, "utf8")) };
    } catch {
      return structuredClone(defaults);
    }
  }

  update(update: Partial<StoredState>): Promise<StoredState> {
    const operation = this.pending.then(async () => {
      const current = await this.readSnapshot();
      const next = { ...current, ...update };
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
