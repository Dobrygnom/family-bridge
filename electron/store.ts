import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type OwnerId = "dima" | "katya";
export type AppLanguage = "ru" | "en" | "cs" | "fr";

export interface StoredState {
  owner: OwnerId;
  onboardingComplete: boolean;
  identityConfigured: boolean;
  displayName: string;
  language: AppLanguage;
  autoStart: boolean;
  pendingTopics: string[];
  blockedTopics: string[];
  reports: string[];
  lastConversationAt?: string;
  remote?: {
    pairId: string;
    encryptionSecret: string;
    inviteSecret?: string;
    peerName?: string;
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
  blockedTopics: [],
  reports: [],
};

export class AtomicStore {
  private readonly file: string;

  constructor(directory: string) {
    this.file = path.join(directory, "state.json");
  }

  async read(): Promise<StoredState> {
    try {
      return { ...defaults, ...JSON.parse(await readFile(this.file, "utf8")) };
    } catch {
      return structuredClone(defaults);
    }
  }

  async update(update: Partial<StoredState>): Promise<StoredState> {
    const current = await this.read();
    const next = { ...current, ...update };
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, JSON.stringify(next, null, 2), "utf8");
    await rename(temporary, this.file);
    return next;
  }
}
