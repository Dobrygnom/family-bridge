import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, rmSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Metadata only. Never accepts exception messages, prompts, names or credentials. */
export class Diagnostics {
  readonly bootId = randomUUID();
  readonly file: string;
  constructor(directory: string) { this.file = path.join(directory, "diagnostics", "lifecycle.jsonl"); }
  record(event: string, fields: { version?: string; onboarding?: boolean; sourceReady?: boolean; analysisStatus?: string; people?: number; topics?: number; reports?: number; stage?: string; current?: number; total?: number; code?: string; elapsedMs?: number } = {}) {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      if (existsSync(this.file) && statSync(this.file).size > 512_000) {
        const previous = `${this.file}.previous`;
        if (existsSync(previous)) rmSync(previous);
        renameSync(this.file, previous);
      }
      appendFileSync(this.file, JSON.stringify({ at: new Date().toISOString(), bootId: this.bootId, event, ...fields }) + "\n");
    } catch { /* Diagnostics must not prevent access to saved data. */ }
  }
}
