// No timer or platform dependency: production and tests share the same gate.
export class AutomaticUpdate {
  private pending = false;
  private checking = false;
  private retryAfter = 0;
  private revision = 0;
  private phase = "idle";
  private phaseStartedAt: number;
  constructor(private readonly hooks: { canInstall:()=>boolean; prepare:()=>Promise<boolean>; install:()=>Promise<void>; resume:()=>void; failed:(error:unknown)=>void; waiting?:(reason:"activity"|"background")=>void }, private readonly now = Date.now) { this.phaseStartedAt = now(); }
  private stage(phase: string) { if (phase !== this.phase) { this.phase = phase; this.phaseStartedAt = this.now(); } }
  snapshot() { return { pending: this.pending, checking: this.checking, phase: this.phase, phaseStartedAt: this.phaseStartedAt, elapsedMs: Math.max(0, this.now() - this.phaseStartedAt), retryAfter: this.retryAfter }; }
  ready() { this.pending = true; }
  requestNow() {
    if (!this.pending) throw new Error("Обновление ещё не скачано. Сначала проверьте обновления.");
    this.retryAfter = 0;
  }
  cancel() { this.pending = false; this.revision++; this.hooks.resume(); this.stage("idle"); }
  async tick() {
    if (!this.pending || this.checking || this.now() < this.retryAfter) return;
    if (!this.hooks.canInstall()) { this.hooks.resume(); this.stage("activity"); this.hooks.waiting?.("activity"); return; }
    this.checking = true;
    const revision = this.revision;
    let prepared = false;
    try {
      if (this.phase !== "background") this.stage("preparing");
      prepared = await this.hooks.prepare();
      if (revision !== this.revision || !this.pending) { this.hooks.resume(); return; }
      if (!prepared) { this.stage("background"); this.hooks.waiting?.("background"); return; }
      if (!this.hooks.canInstall()) { this.hooks.resume(); this.stage("activity"); this.hooks.waiting?.("activity"); return; }
      this.stage("installing");
      await this.hooks.install();
      this.pending = false;
      this.stage("complete");
    } catch (error) {
      this.hooks.resume();
      this.retryAfter = this.now() + 60_000;
      this.stage("retry");
      this.hooks.failed(error);
    } finally { this.checking = false; }
  }
}
