import type { App, CrashReporter } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Diagnostics } from "./diagnostics.js";

export function installCrashDiagnostics(app: Pick<App, "getPath" | "setPath" | "getVersion" | "on">,
  reporter: Pick<CrashReporter, "start" | "getUploadToServer">, diagnostics: Pick<Diagnostics, "record">,
  isUpdating: () => boolean, runtime: Pick<NodeJS.Process, "pid" | "on"> = process) {
  const directory = path.join(app.getPath("userData"), "diagnostics", "crashes");
  try {
    mkdirSync(directory, { recursive: true });
    app.setPath("crashDumps", directory);
    reporter.start({ productName: "Family Bridge", uploadToServer: false, ignoreSystemCrashHandler: false });
    diagnostics.record("crash-capture.started", { filePath: directory, code: reporter.getUploadToServer() ? "UPLOAD_UNEXPECTED" : "LOCAL_ONLY" });
  } catch {
    diagnostics.record("crash-capture.failed");
  }
  const marker = path.join(app.getPath("userData"), "diagnostics", "last-run.json");
  try {
    const previous = JSON.parse(readFileSync(marker, "utf8"));
    if (previous.cleanExit === false) diagnostics.record("process.previous-unfinished", { pid: previous.pid, version: previous.version, modifiedAt: previous.startedAt });
  } catch { /* Older versions have no exit marker. */ }
  const run = { pid: runtime.pid, version: app.getVersion(), startedAt: new Date().toISOString(), cleanExit: false };
  const write = (fields: object = {}) => {
    try { mkdirSync(path.dirname(marker), { recursive: true }); writeFileSync(marker, JSON.stringify({ ...run, ...fields })); }
    catch { diagnostics.record("process.marker-write-failed"); }
  };
  write();
  let quitRequested = false, fatal = false;
  app.on("before-quit", () => { quitRequested = true; diagnostics.record("process.before-quit", { stage: isUpdating() ? "update" : "application" }); });
  app.on("will-quit", () => diagnostics.record("process.will-quit", { stage: isUpdating() ? "update" : "application" }));
  app.on("quit", (_event, exitCode) => diagnostics.record("process.quit", { code: String(exitCode), stage: isUpdating() ? "update" : "application" }));
  app.on("child-process-gone", (_event, details) => diagnostics.record("process.child-gone", { stage: details.type, code: `${details.reason}:${details.exitCode}` }));
  // Observe without swallowing exceptions or replacing Electron's handler.
  // Exception text can contain prompts/tokens; only name and origin are logged.
  runtime.on("uncaughtExceptionMonitor", (error, origin) => { fatal = true; diagnostics.record("process.uncaught-exception", { code: error.name, stage: origin }); });
  runtime.on("exit", code => {
    const cleanExit = code === 0 && quitRequested && !fatal;
    diagnostics.record("process.exit", { code: String(code), stage: isUpdating() ? "update" : "application" });
    write({ cleanExit, exitCode: code, endedAt: new Date().toISOString(), reason: isUpdating() ? "update" : fatal ? "exception" : quitRequested ? "application-quit" : "unexpected-exit" });
  });
}
