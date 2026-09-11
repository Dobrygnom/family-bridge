export const runtimeStages = ["store", "context", "pair", "topics", "receive", "dispatch", "send", "persist"] as const;
type Stage = typeof runtimeStages[number];
type Lane = "dialogue" | "support";
export const powerEvents = ["suspend", "resume", "lock-screen", "unlock-screen", "on-ac", "on-battery", "timer-gap"] as const;
type PowerEvent = typeof powerEvents[number];
interface Operation {
  stage: Stage; startedAt: number; stageStartedAt: number; busy: boolean;
  lastFinishedAt?: number; lastDurationMs?: number; lastFailureAt?: number;
  failureStage?: Stage; code?: string;
}

/** Observations only: a timer gap can mean sleep OR a blocked event loop. */
export class RuntimeDiagnostics {
  private lastTickAt: number;
  private timer?: NodeJS.Timeout;
  private powerState: "unknown" | "suspended" | "resumed" = "unknown";
  private history: Array<{ event: PowerEvent; at: number; elapsedMs?: number }> = [];
  private lanes: Partial<Record<Lane, Operation>> = {};
  constructor(private readonly now = Date.now, private readonly record?: (event: PowerEvent, elapsedMs?: number) => void) { this.lastTickAt = now(); }
  start() {
    if (!this.timer) { this.timer = setInterval(() => this.sample(), 5_000); this.timer.unref(); }
  }
  stop() { clearInterval(this.timer); this.timer = undefined; }
  sample() {
    const at = this.now(), elapsedMs = at - this.lastTickAt;
    if (elapsedMs > 20_000) this.add({ event: "timer-gap", at, elapsedMs });
    this.lastTickAt = at;
  }
  power(event: Exclude<PowerEvent, "timer-gap">) {
    this.sample();
    if (event === "suspend") this.powerState = "suspended";
    if (event === "resume") this.powerState = "resumed";
    this.add({ event, at: this.now() });
  }
  private add(value: typeof this.history[number]) {
    this.history.push(value); this.history = this.history.slice(-24);
    this.record?.(value.event, value.elapsedMs);
  }
  begin(lane: Lane, stage: Stage) {
    const at = this.now();
    this.lanes[lane] = { ...this.lanes[lane], stage, startedAt: at, stageStartedAt: at, busy: true };
  }
  stage(lane: Lane, stage: Stage) {
    const op = this.lanes[lane];
    if (op?.busy) { op.stage = stage; op.stageStartedAt = this.now(); }
  }
  fail(lane: Lane, code: string) {
    const op = this.lanes[lane];
    if (op) { op.lastFailureAt = this.now(); op.failureStage = op.stage; op.code = code; }
  }
  end(lane: Lane) {
    const op = this.lanes[lane];
    if (op) { op.busy = false; op.lastFinishedAt = this.now(); op.lastDurationMs = Math.max(0, this.now() - op.startedAt); }
  }
  snapshot() {
    this.sample();
    return { powerState: this.powerState, lastTickAt: this.lastTickAt, events: this.history.map(e => ({ ...e })),
      operations: Object.entries(this.lanes).map(([lane, op]) => ({ lane, ...op,
        elapsedMs: op.busy ? Math.max(0, this.now() - op.startedAt) : 0,
        stageElapsedMs: op.busy ? Math.max(0, this.now() - op.stageStartedAt) : 0 })) };
  }
}
