import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const profile = await mkdtemp(path.join(os.tmpdir(), "family-bridge-reconcile-"));
const memory = path.join(profile, "psychologist-memory");
const analysisFile = path.join(memory, "context-analysis.json");
const executable = path.resolve("release", "win-unpacked", "Family Bridge.exe");
const port = 9234;
let socket: WebSocket | undefined;
let child: ReturnType<typeof spawn> | undefined;

async function waitFor<T>(operation: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await operation();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Timed out waiting for the packaged UI");
}

try {
  await mkdir(memory, { recursive: true });
  await writeFile(path.join(profile, "state.json"), JSON.stringify({
    owner: "dima", onboardingComplete: false, identityConfigured: true, displayName: "Dmitrii", language: "ru", autoStart: false,
    pendingTopics: [], inFlightTopics: [], blockedTopics: [], reports: [], pendingOwnerQuestions: [],
  }), "utf8");
  await writeFile(path.join(memory, "context-source.json"), JSON.stringify({
    id: "reconcile-test", title: "Карманный психолог", project: "Живи", source: "chatgpt", status: "ready",
    messageCount: 498, lastSyncedAt: new Date().toISOString(),
  }), "utf8");
  const baseAnalysis = {
    analysisVersion: 2, sourceId: "reconcile-test", sourceHash: "test-hash", analyzedAt: new Date().toISOString(),
    status: "analyzing", progress: { stage: "consolidating", current: 6, total: 6 }, people: [], topics: [],
  };
  await writeFile(analysisFile, JSON.stringify(baseAnalysis), "utf8");
  child = spawn(executable, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`], { windowsHide: true, stdio: "ignore" });

  const endpoint = await waitFor(async () => {
    try {
      const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json()) as Array<{ type?: string; webSocketDebuggerUrl?: string }>;
      return pages.find((page) => page.type === "page")?.webSocketDebuggerUrl;
    } catch { return undefined; }
  }, 15_000);
  socket = new WebSocket(endpoint);
  await new Promise<void>((resolve, reject) => {
    socket?.addEventListener("open", () => resolve(), { once: true });
    socket?.addEventListener("error", () => reject(new Error("Could not connect to packaged renderer")), { once: true });
  });
  let nextId = 1;
  const evaluate = async <T>(expression: string): Promise<T> => {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      const listener = (event: MessageEvent) => {
        const message = JSON.parse(String(event.data)) as { id?: number; result?: { result?: { value?: T }; exceptionDetails?: unknown }; error?: { message?: string } };
        if (message.id !== id) return;
        socket?.removeEventListener("message", listener);
        if (message.error || message.result?.exceptionDetails) reject(new Error(message.error?.message ?? "Renderer evaluation failed"));
        else resolve(message.result?.result?.value as T);
      };
      socket?.addEventListener("message", listener);
      socket?.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
    });
  };

  await waitFor(async () => {
    const text = await evaluate<string>(`document.querySelector('main')?.innerText ?? ''`);
    return /Собираем итоговые рекомендации/.test(text) ? text : undefined;
  }, 10_000);
  await writeFile(analysisFile, JSON.stringify({
    ...baseAnalysis,
    status: "ready",
    progress: undefined,
    people: [{ id: "katya", label: "Екатерина", relationship: "партнёр", aliases: [] }],
    topics: [{ id: "topic-1", title: "Обсудить границы", aboutPersonIds: ["katya"], discussWithPersonId: "katya", sensitivity: "direct", reason: "test", approved: false }],
  }), "utf8");
  const finalState = await waitFor(async () => {
    const state = await evaluate<{ processing: boolean; review: string }>(`({ processing: Boolean(document.querySelector('.processing-stage')), review: document.querySelector('.review-stage')?.textContent ?? '' })`);
    return !state.processing && /Обсудить границы/.test(state.review) ? state : undefined;
  }, 5_000);
  assert.equal(finalState.processing, false);
  assert.match(finalState.review, /Обсудить границы/);
  const status = await evaluate<string | undefined>(`window.familyBridge.getLocalContextState().then((state) => state.contextAnalysis?.status)`);
  assert.equal(status, "ready");
  console.log(JSON.stringify({ lostEventRecovered: true, status, pollIntervalMs: 1000 }));
} finally {
  socket?.close();
  child?.kill();
  await new Promise((resolve) => setTimeout(resolve, 500));
  await rm(profile, { recursive: true, force: true });
}
