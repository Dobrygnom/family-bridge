// No timer or platform dependency: production and tests share the same gate.
export class AutomaticUpdate {
  private pending = false;
  private checking = false;
  private retryAfter = 0;
  constructor(private readonly hooks: { canInstall:()=>boolean; prepare:()=>Promise<boolean>; install:()=>Promise<void>; resume:()=>void; failed:(error:unknown)=>void; waiting?:(reason:"activity"|"background")=>void }, private readonly now = Date.now) {}
  ready() { this.pending = true; }
  requestNow() {
    if (!this.pending) throw new Error("Обновление ещё не скачано. Сначала проверьте обновления.");
    this.retryAfter = 0;
  }
  cancel() { this.pending = false; }
  async tick() {
    if (!this.pending || this.checking || this.now() < this.retryAfter) return;
    if (!this.hooks.canInstall()) { this.hooks.waiting?.("activity"); return; }
    this.checking = true;
    let prepared = false;
    try {
      prepared = await this.hooks.prepare();
      if (!prepared) { this.hooks.waiting?.("background"); return; }
      if (!this.hooks.canInstall()) { this.hooks.resume(); this.hooks.waiting?.("activity"); return; }
      await this.hooks.install();
      this.pending = false;
    } catch (error) {
      this.hooks.resume();
      this.retryAfter = this.now() + 60_000;
      this.hooks.failed(error);
    } finally { this.checking = false; }
  }
}
