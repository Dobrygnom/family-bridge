import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const profile = await mkdtemp(path.join(os.tmpdir(), "family-bridge-results-"));
const memory = path.join(profile, "psychologist-memory");
const reports = path.join(profile, "reports");
const executable = path.resolve("release", "win-unpacked", "Family Bridge.exe");
const port = 9237;
let socket: WebSocket | undefined;
let child: ReturnType<typeof spawn> | undefined;

async function waitFor<T>(operation: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await operation();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Timed out waiting for conversation results UI");
}

try {
  await mkdir(memory, { recursive: true });
  await mkdir(reports, { recursive: true });
  const reportPath = path.join(reports, "completed.json");
  await writeFile(reportPath, JSON.stringify({ conversationId: "completed-1", topic: "Готовая тема", sharedSummary: "Короткий ответ прямо в приложении.", answerFrom: "Катя", answerFromOwnerId: "katya", topicSources: ["local", "peer"], comparisonSummary: "Дмитрий задал вопрос, Катя дала прямой ответ.", completedAt: "2026-09-01T16:20:00.000Z", messages: [{ from: "dima", text: "Что ты думаешь?" }, { from: "katya", text: "Вот что я думаю." }] }), "utf8");
  await writeFile(path.join(profile, "state.json"), JSON.stringify({
    owner: "dima", onboardingComplete: true, identityConfigured: true, displayName: "Dmitrii", language: "ru", autoStart: false,
    pendingTopics: ["Тема в очереди"], inFlightTopics: [], pairTopics: ["Выбранная тема", "Тема в очереди", "Активная тема", "Готовая тема"], topicSources: { "Выбранная тема": ["local"], "Тема в очереди": ["peer"], "Активная тема": ["local", "peer"], "Готовая тема": ["local", "peer"] }, topicSourceMigrationVersion: "0.3.27", activeTopics: ["Активная тема"],
    blockedTopics: [], reports: [reportPath], pendingOwnerQuestions: [], conversationResetVersion: "0.3.25", ignoredConversationIds: [],
  }), "utf8");
  await writeFile(path.join(memory, "context-source.json"), JSON.stringify({ id: "results-test", title: "Карманный психолог", project: "Живи", source: "chatgpt", status: "ready", messageCount: 498, lastSyncedAt: new Date().toISOString() }), "utf8");
  await writeFile(path.join(memory, "learned-context.json"), JSON.stringify([{ id: "learned-1", topic: "Готовая тема", question: "Что для тебя важно?", disposition: "answer", answer: "Чтобы меня услышали", recordedAt: new Date().toISOString() }]), "utf8");
  await writeFile(path.join(memory, "context-analysis.json"), JSON.stringify({
    analysisVersion: 2, sourceId: "results-test", sourceHash: "results-hash", analyzedAt: new Date().toISOString(), status: "ready",
    people: [{ id: "katya", label: "Екатерина", relationship: "партнёр", aliases: [] }], topics: [],
  }), "utf8");
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
  const topicRows = await waitFor(async () => {
    const rows = await evaluate<string[]>(`[...document.querySelectorAll('.pair-topic')].map((row) => row.textContent?.trim() ?? '')`);
    return rows.length === 4 ? rows : undefined;
  });
  assert.ok(topicRows.some((row) => /Выбранная тема.*Выбрана/.test(row)));
  assert.ok(topicRows.some((row) => /Тема в очереди.*Ждёт запуска/.test(row)));
  assert.ok(topicRows.some((row) => /Активная тема.*Ждём ответ второго агента/.test(row)));
  assert.ok(topicRows.some((row) => /Готовая тема.*Итог готов/.test(row)));
  await evaluate(`(() => { const button = [...document.querySelectorAll('nav button')].find((item) => item.textContent?.trim() === 'Итоги разговоров'); if (!(button instanceof HTMLElement)) return false; button.click(); return true; })()`);
  const reportText = await waitFor(async () => {
    const text = await evaluate<string>(`document.querySelector('.report-card')?.textContent ?? ''`);
    return /Короткий ответ прямо в приложении/.test(text) ? text : undefined;
  });
  assert.match(reportText, /Готовая тема/);
  assert.match(reportText, /Источник темы: Dmitrii \+ Партнёр/);
  assert.match(reportText, /Предполагаемая реплика — Dmitrii/);
  assert.match(reportText, /Предполагаемая реплика — компьютер партнёра/);
  assert.match(reportText, /Что стало понятно.*Дмитрий задал вопрос, Катя дала прямой ответ/);
  const openedTranscript = await evaluate<boolean>(`(() => { const details = document.querySelector('.report-transcript'); if (!(details instanceof HTMLDetailsElement)) return false; details.open = true; return true; })()`);
  assert.ok(openedTranscript);
  const transcript = await evaluate<string>(`document.querySelector('.report-transcript')?.textContent ?? ''`);
  assert.match(transcript, /Что ты думаешь\?/);
  assert.match(transcript, /Вот что я думаю\./);
  await evaluate(`(() => { const button = [...document.querySelectorAll('nav button')].find((item) => item.textContent?.trim() === 'Исходный чат и темы'); if (!(button instanceof HTMLElement)) return false; button.click(); return true; })()`);
  const contextText = await waitFor(async () => {
    const text = await evaluate<string>(`document.querySelector('.context-current')?.textContent ?? ''`);
    return /Запомнено из ответов/.test(text) ? text : undefined;
  });
  assert.match(contextText, /Запомнено из ответов\s*1/);
  console.log(JSON.stringify({ persistentTopics: topicRows.length, statuses: true, shortAnswer: true, readableTranscript: true, learnedAnswersVisible: true }));
} finally {
  socket?.close();
  child?.kill();
  await new Promise((resolve) => setTimeout(resolve, 500));
  await rm(profile, { recursive: true, force: true });
}
