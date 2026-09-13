import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { replaceStateFile } from "./store.js";

export interface UiErrorSnapshot {
  schema: 1; totalShown: number; currentlyVisible: boolean; visibleCount: number;
  lastShownAt?: string; lastClearedAt?: string;
  recent: Array<{ at: string; state: "shown" | "updated" | "cleared"; occurrenceId?: string; visibleCount: number }>;
}
const empty = (): UiErrorSnapshot => ({ schema: 1, totalShown: 0, currentlyVisible: false, visibleCount: 0, recent: [] });
const occurrence = (value: unknown) => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value) ? value : undefined;

/** Durable evidence of what the renderer actually displayed. Error text never crosses the IPC boundary. */
export class UiErrorDiagnostics {
  private readonly file: string;
  private pending: Promise<void> = Promise.resolve();
  constructor(directory: string) { this.file = path.join(directory, "diagnostics", "ui-errors.json"); }
  async snapshot(): Promise<UiErrorSnapshot> {
    await this.pending;
    try {
      const value = JSON.parse(await readFile(this.file, "utf8")) as UiErrorSnapshot;
      if (value?.schema === 1 && Number.isSafeInteger(value.totalShown) && Array.isArray(value.recent)) return value;
    } catch { /* Missing/corrupt UI telemetry starts a new diagnostic history, never application state. */ }
    return empty();
  }
  record(input: unknown): Promise<void> {
    const row = input as { visible?: unknown; visibleCount?: unknown; occurrenceId?: unknown } | null;
    if (typeof row?.visible !== "boolean" || !Number.isSafeInteger(row.visibleCount) || Number(row.visibleCount) < 0 || Number(row.visibleCount) > 100) return Promise.resolve();
    const visible = row.visible, visibleCount = Number(row.visibleCount), occurrenceId = occurrence(row.occurrenceId);
    if (visible && !occurrenceId) return Promise.resolve();
    this.pending = this.pending.catch(() => undefined).then(async () => {
      const current = await this.snapshotUnlocked(), at = new Date().toISOString();
      const previousOccurrence = [...current.recent].reverse().find(item => item.state !== "cleared")?.occurrenceId;
      if (current.currentlyVisible === visible && current.visibleCount === visibleCount && (!visible || previousOccurrence === occurrenceId)) return;
      const state: "shown" | "updated" | "cleared" = !visible ? "cleared" : current.currentlyVisible ? "updated" : "shown";
      const next: UiErrorSnapshot = { schema: 1, totalShown: current.totalShown + (state === "shown" ? 1 : 0), currentlyVisible: visible, visibleCount,
        lastShownAt: state === "shown" ? at : current.lastShownAt, lastClearedAt: state === "cleared" ? at : current.lastClearedAt,
        recent: [...current.recent, { at, state, ...(occurrenceId ? { occurrenceId } : {}), visibleCount }].slice(-100) };
      await mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
      await replaceStateFile(temporary, this.file);
    });
    return this.pending;
  }
  private async snapshotUnlocked() {
    try {
      const value = JSON.parse(await readFile(this.file, "utf8")) as UiErrorSnapshot;
      return value?.schema === 1 && Number.isSafeInteger(value.totalShown) && Array.isArray(value.recent) ? value : empty();
    } catch { return empty(); }
  }
}
