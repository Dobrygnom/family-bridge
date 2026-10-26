import { UpdateActivity } from "./update-activity.js";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { TopicBrief } from "../src/core/conversation-quality.js";
import type { RemoteEnvelope } from "../src/core/supabase-transport.js";
import type { AgentResponse } from "../src/core/types.js";
import type { MessageOrigin, SharedMessage } from "../src/core/continuation.js";
import type { PairRecovery } from "../src/core/pair-recovery.js";
import type { CodexModel, CodexReasoningEffort } from "../src/core/codex-settings.js";
import type { ReadingReceiptSnapshot, ReadingState } from "../src/core/conversation-attention.js";

export type OwnerId = "dima" | "katya";
export type AppLanguage = "ru" | "en" | "cs" | "fr";
export type OwnerQuestionDisposition = "answer" | "unknown" | "decline";
export type TopicSource = "local" | "peer" | "unknown";
export interface StoreRecoveryStatus {
  usedPrevious: true;
  reason: "missing-primary" | "invalid-primary";
  recoveredAt: string;
  repairedAt?: string;
  invalidPrimaryPreserved?: boolean;
}
export interface ConversationContinuation {
  mode?: "restart" | "clean-continuation";
  originReportId?: string;
  attempts?: number;
  retryAt?: number;
  connectivityRetryUsed?: boolean;
  failureKind?: "unsafe" | "connection" | "generation" | "delivery";
  failureCode?: string;
  parentReportId: string;
  topic: string;
  pairId: string;
  instruction: string;
  history: SharedMessage[];
  status: "starting" | "preview" | "waiting" | "complete" | "error";
  approvalRequired?: boolean;
  approvedAt?: string;
  preparedMessage?: string;
  replyOrigin?: MessageOrigin;
  preparedSentAt?: string;
}

export interface PendingOwnerQuestion {
  id: string;
  conversationId: string;
  topic: string;
  question: string;
  createdAt: string;
  peerName?: string;
  nextSequence: number;
  transcript: SharedMessage[];
  ownerResponseRecorded?: boolean;
  preparedResponse?: AgentResponse;
  preparedSentAt?: string;
  manualReply?: boolean;
}

export interface PendingManualReply {
  id: string;
  conversationId: string;
  topic: string;
  createdAt: string;
  peerName?: string;
  nextSequence: number;
  transcript: SharedMessage[];
  text?: string;
  sentAt?: string;
}

export interface StoredState {
  conversationReading?: ReadingState;
  peerConversationReading?: { pairId: string; owner: OwnerId; receivedAt: string; receipt: ReadingReceiptSnapshot };
  topicLaunches: Record<string, { topic: string; pairId: string; status: "preparing" | "waiting" | "error" | "complete"; preparedMessage?: string; preparedSentAt?: string; openingBrief?: TopicBrief; approvedOpening?: boolean; openingOrigin?: "agent" | "owner-answer"; attempts: number; retryAt?: number; failureCode?: string }>;
  owner: OwnerId;
  onboardingComplete: boolean;
  identityConfigured: boolean;
  processingMode?: "local" | "trusted";
  conversationReplyMode: "automatic" | "manual";
  preferredCounterpartPersonId?: string;
  displayName: string;
  language: AppLanguage;
  autoStart: boolean;
  codexModel?: CodexModel;
  codexReasoningEffort?: CodexReasoningEffort;
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
  pendingManualReplies: PendingManualReply[];
  conversationTranscripts: Record<string, { topic: string; messages: SharedMessage[] }>;
  conversationInheritedCounts: Record<string, number>;
  conversationResetVersion?: string;
  conversationResetAt?: string;
  experienceResetVersion?: string;
  experienceResetAt?: string;
  ignoredConversationIds: string[];
  continuations: Record<string, ConversationContinuation>;
  conversationParents: Record<string, string>;
  conversationModes: Record<string, "restart" | "clean-continuation">;
  roleRepairCutoffAt?: string;
  incomingDeliveries: Record<string, { envelope: RemoteEnvelope; received?: boolean; response?: AgentResponse; responseSentAt?: string; responseSent?: boolean; attempts?: number; retryAt?: number; failureCode?: string }>;
  quarantinedDeliveries: Record<string, { envelope: RemoteEnvelope; code: "INVALID_PROTOCOL"; failedAt: string }>;
  completedIncoming: string[];
  lastConversationAt?: string;
  remote?: {
    pairId: string;
    encryptionSecret: string;
    inviteSecret?: string;
    peerName?: string;
    peerVersion?: string;
    peerVersionObservedAt?: string;
    peerExperienceVersion?: string;
    peerLastSeenAt?: string;
    peerPresenceAt?: string;
    counterpartPersonId?: string;
    recoveryRoute?: PairRecovery;
  };
}

const defaults: StoredState = {
  topicLaunches: {},
  owner: "dima",
  onboardingComplete: false,
  identityConfigured: false,
  displayName: "",
  language: "ru",
  autoStart: true,
  conversationReplyMode: "automatic",
  codexModel: "gpt-5.6-sol",
  codexReasoningEffort: "medium",
  pendingTopics: [],
  inFlightTopics: [],
  pairTopics: [],
  topicSources: {},
  topicBriefs: {},
  activeTopics: [],
  blockedTopics: [],
  reports: [],
  pendingOwnerQuestions: [],
  pendingManualReplies: [],
  conversationTranscripts: {},
  conversationInheritedCounts: {},
  ignoredConversationIds: [],
  continuations: {},
  conversationParents: {},
  conversationModes: {},
  incomingDeliveries: {},
  quarantinedDeliveries: {},
  completedIncoming: [],
};

export async function replaceStateFile(temporary: string, destination: string) {
  // writeFile() only hands bytes to the operating system. Flush the completed
  // temporary file before it becomes authoritative so a successful mutation
  // means the payload survives a process crash (and, where the filesystem
  // honours FlushFileBuffers/fsync, an abrupt machine restart).
  const temporaryHandle = await open(temporary, "r+");
  try { await temporaryHandle.sync(); } finally { await temporaryHandle.close(); }

  // Windows scanners/readers can hold the destination longer than a few hundred
  // milliseconds. Keep the write queue locked while retrying the SAME snapshot;
  // never remove the destination or fall back to a non-atomic overwrite.
  let waitedMs = 0;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporary, destination);
      // Persist the directory entry on filesystems that support directory
      // fsync. Windows does not expose this through Node, so the file flush
      // above remains the authoritative durability barrier there.
      if (process.platform !== "win32") try {
        const directoryHandle = await open(path.dirname(destination), "r");
        try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
      } catch { /* Best effort when a filesystem does not allow directory fsync. */ }
      return;
    }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (waitedMs >= 10_000 || code !== "EPERM" && code !== "EBUSY") throw error;
      const waitMs = Math.min(10 * 2 ** Math.min(attempt, 6), 500, 10_000 - waitedMs);
      await delay(waitMs);
      waitedMs += waitMs;
    }
  }
}

/** Writes a complete file durably, without ever exposing a partial destination. */
export async function writeDurableFile(destination: string, data: string | Buffer) {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data, { mode: 0o600 });
    await replaceStateFile(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export class AtomicStore {
  readonly updateActivity = new UpdateActivity();
  private readonly file: string;
  private pending: Promise<void> = Promise.resolve();
  private recovery?: StoreRecoveryStatus;

  constructor(directory: string) {
    this.file = path.join(directory, "state.json");
  }

  async read(): Promise<StoredState> {
    await this.pending;
    return this.readSnapshot();
  }

  recoveryStatus(): StoreRecoveryStatus | undefined {
    return this.recovery ? { ...this.recovery } : undefined;
  }

  async repairRecoveredState(): Promise<StoredState> {
    return this.recovery && !this.recovery.repairedAt ? this.mutate(() => ({})) : this.read();
  }

  private normalize(value: unknown): StoredState {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid saved state");
    const record = value as Partial<StoredState>;
    const ownerQuestions = Array.isArray(record.pendingOwnerQuestions) ? record.pendingOwnerQuestions : [];
    const savedManual = Array.isArray(record.pendingManualReplies) ? record.pendingManualReplies : [];
    const legacyManual = ownerQuestions.filter((item) => item?.manualReply === true).map((item): PendingManualReply => ({
      id: item.id,
      conversationId: item.conversationId,
      topic: item.topic,
      createdAt: item.createdAt,
      peerName: item.peerName,
      nextSequence: item.nextSequence,
      transcript: item.transcript,
      text: item.preparedResponse?.message_to_peer,
      sentAt: item.preparedSentAt,
    }));
    const manualByConversation = new Map([...legacyManual, ...savedManual].map((item) => [item.conversationId, item]));
    return { ...defaults, ...record,
      pendingOwnerQuestions: ownerQuestions.filter((item) => item?.manualReply !== true),
      pendingManualReplies: [...manualByConversation.values()],
    } as StoredState;
  }

  private async readSnapshot(): Promise<StoredState> {
    try {
      return this.normalize(JSON.parse(await readFile(this.file, "utf8")));
    } catch (error) {
      try {
        const previous = this.normalize(JSON.parse(await readFile(`${this.file}.previous`, "utf8")));
        this.recovery ??= {
          usedPrevious: true,
          reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing-primary" : "invalid-primary",
          recoveredAt: new Date().toISOString(),
        };
        return previous;
      } catch (backupError) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && (backupError as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(defaults);
      }
      // A broken/unreadable file is NOT a new installation. Never overwrite it
      // with defaults on the next settings change. A valid previous generation
      // is accepted above; otherwise preserve both files for diagnosis.
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
      const nextText = JSON.stringify(next, null, 2);
      const backup = `${this.file}.previous`;
      const backupTemporary = `${backup}.tmp`;
      // Keep a complete verified generation independent of the main rename.
      // On the first write the new generation is the only valid recovery point;
      // afterwards the backup intentionally trails the main file by one commit.
      let mainExists = true;
      try { await readFile(this.file); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") mainExists = false;
        else throw error;
      }
      if (mainExists && this.recovery?.reason === "invalid-primary" && !this.recovery.invalidPrimaryPreserved) {
        const stamp = this.recovery.recoveredAt.replace(/[:.]/g, "-");
        await writeDurableFile(`${this.file}.corrupt-${stamp}`, await readFile(this.file));
        this.recovery.invalidPrimaryPreserved = true;
      }
      await writeFile(backupTemporary, mainExists ? JSON.stringify(current, null, 2) : nextText, { encoding: "utf8", mode: 0o600 });
      await replaceStateFile(backupTemporary, backup);
      const temporary = `${this.file}.tmp`;
      await writeFile(temporary, nextText, { encoding: "utf8", mode: 0o600 });
      await replaceStateFile(temporary, this.file);
      if (this.recovery && !this.recovery.repairedAt) this.recovery.repairedAt = new Date().toISOString();
      return next;
    });
    this.pending = this.updateActivity.track("state_writes", operation).then(() => undefined, () => undefined);
    return operation;
  }
}
