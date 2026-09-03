import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Exercise the actual packaged JavaScript/dependencies using Electron's Node mode.
// No window, no real profile, no remote/LLM calls, no installation changes.
if (process.argv.includes("--child")) {
  const archive = process.argv.at(-1);
  const { AtomicStore } = await import(pathToFileURL(path.join(archive, "dist-electron/electron/store.js")).href);
  const { BackgroundService } = await import(pathToFileURL(path.join(archive, "dist-electron/electron/background-service.js")).href);
  const directory = await mkdtemp(path.join(os.tmpdir(), "fb-packaged-state-"));
  try {
    const store = new AtomicStore(directory);
    const service = new BackgroundService(directory, path.dirname(archive), store, () => null, undefined, { backgroundTasks: false });
    await service.start();
    assert.equal((await service.state()).onboardingComplete, false);
    await store.update({ onboardingComplete: true, pairTopics: ["retained-topic"], conversationResetVersion: "0.3.25" });
    await mkdir(path.join(directory, "psychologist-memory"));
    await writeFile(path.join(directory, "psychologist-memory/context-source.json"), JSON.stringify({ id: "test-source", status: "ready", messageCount: 498 }));
    await writeFile(path.join(directory, "psychologist-memory/context-analysis.json"), JSON.stringify({ sourceId: "test-source", status: "ready", people: [{ id: "partner" }], topics: [] }));
    const restarted = new BackgroundService(directory, path.dirname(archive), store, () => null, undefined, { backgroundTasks: false, conversationResetVersion: "0.3.25" });
    await restarted.start();
    const snapshot = await restarted.state();
    assert.equal(snapshot.onboardingComplete, true);
    assert.equal(snapshot.contextAnalysis.status, "ready");
    assert.deepEqual(snapshot.pairTopics, ["retained-topic"]);
    assert.equal(typeof restarted.continueReport, "function");
    console.log(JSON.stringify({ packagedState: "passed", freshInstall: true, savedProfile: true, continuationAvailable: true }));
  } finally { await rm(directory, { recursive: true, force: true }); }
} else {
  const executable = path.resolve(process.argv[2] || (process.platform === "darwin" ? `release/${process.arch === "arm64" ? "mac-arm64" : "mac"}/Family Bridge.app/Contents/MacOS/Family Bridge` : "release/win-unpacked/Family Bridge.exe"));
  const resources = process.platform === "darwin" ? path.resolve(path.dirname(executable), "../Resources") : path.join(path.dirname(executable), "resources");
  const child = spawn(executable, [fileURLToPath(import.meta.url), "--child", path.join(resources, "app.asar")], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true, stdio: "inherit" });
  const timer = setTimeout(() => { child.kill(); process.exitCode = 1; }, 30_000);
  child.on("error", (error) => { clearTimeout(timer); console.error(error); process.exitCode = 1; });
  child.on("exit", (code) => { clearTimeout(timer); process.exitCode = code ?? 1; });
}
