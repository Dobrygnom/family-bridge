/** Technical operation names only; never include arguments, topics or paths. */
export const updateOperations = ['automatic_dispatch','remote_poll','remote_workers','topic_launches','continuations','owner_answers','context_sync','context_check','portraits','conversation','topic_edits','analysis_writes','portrait_queue','state_writes','save_barrier','ipc'] as const;
export type UpdateOperation = typeof updateOperations[number];
export interface UpdateBlocker { operation: UpdateOperation; count: number; startedAt: number; elapsedMs: number }

export class UpdateActivity {
  private entries = new Map<UpdateOperation, Map<symbol, number>>();
  private flags = new Map<UpdateOperation, () => void>();
  constructor(private readonly now = Date.now) {}
  begin(operation: UpdateOperation) {
    const token = Symbol();
    const entries = this.entries.get(operation) ?? new Map<symbol, number>();
    entries.set(token, this.now()); this.entries.set(operation, entries);
    return () => { entries.delete(token); if (!entries.size) this.entries.delete(operation); };
  }
  flag(operation: UpdateOperation, active?: boolean): boolean {
    if (active === true && !this.flags.has(operation)) this.flags.set(operation, this.begin(operation));
    if (active === false) { this.flags.get(operation)?.(); this.flags.delete(operation); }
    return this.flags.has(operation);
  }
  track<T>(operation: UpdateOperation, promise: Promise<T>): Promise<T> {
    const end = this.begin(operation); return promise.finally(end);
  }
  snapshot(): UpdateBlocker[] {
    return [...this.entries].map(([operation, entries]) => {
      const startedAt = Math.min(...entries.values());
      return { operation, count: entries.size, startedAt, elapsedMs: Math.max(0, this.now() - startedAt) };
    });
  }
}

export class ActivityMap<K, V> extends Map<K, V> {
  private ends = new Map<K, () => void>();
  constructor(private readonly activity: UpdateActivity, private readonly operation: UpdateOperation) { super(); }
  override set(key: K, value: V) { if (!this.has(key)) this.ends.set(key, this.activity.begin(this.operation)); return super.set(key, value); }
  override delete(key: K) { this.ends.get(key)?.(); this.ends.delete(key); return super.delete(key); }
  override clear() { for (const end of this.ends.values()) end(); this.ends.clear(); super.clear(); }
}

export class ActivitySet<K> extends Set<K> {
  private ends = new Map<K, () => void>();
  constructor(private readonly activity: UpdateActivity, private readonly operation: UpdateOperation) { super(); }
  override add(key: K) { if (!this.has(key)) this.ends.set(key, this.activity.begin(this.operation)); return super.add(key); }
  override delete(key: K) { this.ends.get(key)?.(); this.ends.delete(key); return super.delete(key); }
  override clear() { for (const end of this.ends.values()) end(); this.ends.clear(); super.clear(); }
}

export const updateIpcChannels = ["bridge:update-blocked", "bridge:notify-conversation", "bridge:get-state", "bridge:diagnose-ui", "bridge:open-diagnostics", "bridge:get-local-context-state", "bridge:add-topic", "bridge:block-topic", "bridge:run-conversation", "bridge:set-autostart", "bridge:set-display-name", "bridge:set-language", "bridge:list-context-threads", "bridge:select-context-thread", "bridge:sync-context", "bridge:refresh-context-now", "bridge:update-portrait-observation", "bridge:complete-onboarding", "bridge:open-reports", "bridge:create-pair", "bridge:join-pair", "bridge:update-context-topic", "bridge:refine-context-topic", "bridge:update-context-topics", "bridge:run-remote", "bridge:discuss-all-topics", "bridge:answer-owner-question", "bridge:continue-report", "bridge:retry-continuation", "bridge:request-microphone", "bridge:transcribe-audio", "bridge:cancel-dictation", "bridge:check-updates", "bridge:check-pair-versions", "bridge:install-update"] as const;
