import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { installCrashDiagnostics } from "../electron/crash-diagnostics.js";

for (const ending of ["update", "quit", "exception", "interrupted"] as const) test(`local crash capture and exit classification: ${ending}`, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fb-crash-unit-"));
  const records: any[] = [], app = Object.assign(new EventEmitter(), { getPath: () => dir, getVersion: () => "test", setPath: (key: string, value: string) => { assert.equal(key, "crashDumps"); assert.equal(value, path.join(dir, "diagnostics", "crashes")); } });
  const runtime = Object.assign(new EventEmitter(), { pid: 123 });
  let started = false;
  try {
    installCrashDiagnostics(app as any, { start: options => { assert.equal(options.uploadToServer, false); assert.equal(options.submitURL, undefined); started = true; }, getUploadToServer: () => false }, { record: (event, fields) => records.push({event,...fields}) }, () => ending === "update", runtime as any);
    assert.ok(started);
    if (ending === "update" || ending === "quit") { app.emit("before-quit"); app.emit("will-quit"); app.emit("quit", {}, 0); }
    if (ending === "exception") runtime.emit("uncaughtExceptionMonitor", new Error("PRIVATE_TOKEN_AND_PROMPT"), "uncaughtException");
    if (ending !== "interrupted") runtime.emit("exit", ending === "exception" ? 1 : 0);
    const marker = JSON.parse(readFileSync(path.join(dir,"diagnostics/last-run.json"),"utf8"));
    assert.equal(marker.cleanExit, ending === "update" || ending === "quit");
    assert.doesNotMatch(JSON.stringify(records), /PRIVATE_TOKEN_AND_PROMPT/);
    assert.equal(runtime.listenerCount("uncaughtException"), 0);
    if (ending === "interrupted") {
      installCrashDiagnostics(app as any, { start: () => {}, getUploadToServer: () => false }, { record: (event,fields) => records.push({event,...fields}) }, () => false, runtime as any);
      assert.ok(records.some(r=>r.event === "process.previous-unfinished"));
    }
  } finally { rmSync(dir, {recursive:true,force:true}); }
});
