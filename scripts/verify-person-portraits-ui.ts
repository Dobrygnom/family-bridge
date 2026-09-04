import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const sourceProfile = process.env.FAMILY_BRIDGE_USER_DATA || path.join(process.env.APPDATA || "", "family-bridge");
const analysisFile = process.env.FAMILY_BRIDGE_PORTRAIT_ANALYSIS || path.join(os.tmpdir(), "family-bridge-person-portraits-validation.json");
const removeDefaultAnalysisAfterRun = !process.env.FAMILY_BRIDGE_PORTRAIT_ANALYSIS;
const profile = await mkdtemp(path.join(os.tmpdir(), "family-bridge-portraits-ui-"));
const memory = path.join(profile, "psychologist-memory");
const executable = path.resolve("release", "win-unpacked", "Family Bridge.exe");
const port = 9241;
let socket: WebSocket | undefined;
let child: ReturnType<typeof spawn> | undefined;

async function waitFor<T>(operation: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await operation();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Timed out waiting for person portraits UI");
}

try {
  await mkdir(memory, { recursive: true });
  const state = JSON.parse(await readFile(path.join(sourceProfile, "state.json"), "utf8")) as Record<string, unknown>;
  await writeFile(path.join(profile, "state.json"), JSON.stringify({
    ...state,
    autoStart: false,
    reports: [],
    pendingOwnerQuestions: [],
    experienceResetVersion: "natural-dialogues-v1",
    conversationResetVersion: "0.3.25",
  }), "utf8");
  await copyFile(path.join(sourceProfile, "psychologist-memory", "context-source.json"), path.join(memory, "context-source.json"));
  await copyFile(analysisFile, path.join(memory, "context-analysis.json"));

  child = spawn(executable, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`], {
    windowsHide: true,
    stdio: "ignore",
    env: { ...process.env, FAMILY_BRIDGE_E2E_ALLOW_SECOND_INSTANCE: "1", FAMILY_BRIDGE_E2E_USER_DATA: profile },
  });
  const endpoint = await waitFor(async () => {
    try {
      const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json()) as Array<{ type?: string; url?: string; webSocketDebuggerUrl?: string }>;
      return pages.find((page) => page.type === "page" && page.url?.startsWith("file:"))?.webSocketDebuggerUrl;
    } catch { return undefined; }
  });
  socket = new WebSocket(endpoint);
  await new Promise<void>((resolve, reject) => {
    socket?.addEventListener("open", () => resolve(), { once: true });
    socket?.addEventListener("error", () => reject(new Error("Could not connect to packaged renderer")), { once: true });
  });
  await new Promise((resolve) => setTimeout(resolve, 1_000));
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

  const startup = await evaluate<{ context?: string; analysis?: string; portraits?: number; error?: string }>(`window.familyBridge.getState().then((state) => ({ context: state.context?.status, analysis: state.contextAnalysis?.status, portraits: state.contextAnalysis?.portraits?.length ?? 0, error: state.contextAnalysis?.error }))`);
  if (!startup.portraits) console.error(JSON.stringify({ profile, startup }));

  const portraitCount = await waitFor(async () => {
    const value = await evaluate<number>(`window.familyBridge.getState().then((state) => state.contextAnalysis?.portraits?.length ?? 0)`);
    return value > 1 ? value : undefined;
  });
  assert.ok(await waitFor(async () => {
    const clicked = await evaluate<boolean>(`(() => { const button = [...document.querySelectorAll('nav button')].find((item) => item.textContent?.trim() === 'Что знает мой агент'); if (!(button instanceof HTMLElement)) return false; button.click(); return true; })()`);
    return clicked || undefined;
  }));
  const tabCount = await waitFor(async () => {
    const value = await evaluate<number>(`document.querySelectorAll('.portrait-person-tabs button').length`);
    return value === portraitCount ? value : undefined;
  });
  const initialObservationCount = await evaluate<number>(`document.querySelectorAll('.portrait-observation').length`);
  assert.ok(initialObservationCount > 0, "Owner portrait has no visible observations");
  const ownerSelected = await evaluate<boolean>(`document.querySelector('.portrait-person-tabs button[aria-selected="true"] small')?.textContent?.trim() === 'Вы'`);
  assert.equal(ownerSelected, true, "Owner portrait is not selected first");
  assert.ok(await evaluate<boolean>(`(() => { const button = document.querySelector('.portrait-observation-actions button[aria-label="Исправить"]'); if (!(button instanceof HTMLElement)) return false; button.click(); return true; })()`));
  assert.ok(await waitFor(async () => await evaluate<boolean>(`document.querySelector('.portrait-edit textarea') instanceof HTMLTextAreaElement`) || undefined));
  const editedText = "Проверочное исправление портрета.";
  assert.ok(await evaluate<boolean>(`(() => { const textarea = document.querySelector('.portrait-edit textarea'); if (!(textarea instanceof HTMLTextAreaElement)) return false; const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set; setter?.call(textarea, ${JSON.stringify(editedText)}); textarea.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`));
  assert.ok(await evaluate<boolean>(`(() => { const button = [...document.querySelectorAll('.portrait-edit button')].find((item) => item.textContent?.trim() === 'Сохранить'); if (!(button instanceof HTMLElement)) return false; button.click(); return true; })()`));
  await waitFor(async () => {
    const found = await evaluate<boolean>(`[...document.querySelectorAll('.portrait-observation p')].some((item) => item.textContent?.trim() === ${JSON.stringify(editedText)})`);
    return found || undefined;
  });
  const persisted = await evaluate<boolean>(`window.familyBridge.getState().then((state) => state.contextAnalysis?.portraits?.some((portrait) => portrait.isOwner && portrait.observations.some((item) => item.text === ${JSON.stringify(editedText)} && item.userEdited === true)) ?? false)`);
  assert.equal(persisted, true, "Edited observation was not persisted through IPC");
  assert.ok(await evaluate<boolean>(`(() => { const buttons = [...document.querySelectorAll('.portrait-person-tabs button')]; const next = buttons.find((button) => !button.querySelector('small')); if (!(next instanceof HTMLElement)) return false; next.click(); return true; })()`));
  assert.ok(await waitFor(async () => {
    const count = await evaluate<number>(`document.querySelectorAll('.portrait-observation').length`);
    return count > 0 ? count : undefined;
  }));
  assert.ok(await evaluate<boolean>(`(() => { const button = [...document.querySelectorAll('nav button')].find((item) => item.textContent?.trim() === 'Первый запуск'); if (!(button instanceof HTMLElement)) return false; button.click(); return true; })()`));
  const overflow = await evaluate<{ pageX: number; mainY: number }>(`({ pageX: document.documentElement.scrollWidth - document.documentElement.clientWidth, mainY: (() => { const main = document.querySelector('main'); return main ? main.scrollHeight - main.clientHeight : 1; })() })`);
  assert.ok(overflow.pageX <= 1, `Packaged app has horizontal overflow: ${overflow.pageX}px`);
  assert.ok(overflow.mainY <= 1, `First-run screen scrolls as a whole: ${overflow.mainY}px`);
  console.log(JSON.stringify({ verified: true, packagedVersion: "1.2.2", people: tabCount, ownerObservations: initialObservationCount, editPersisted: true, personSwitch: true, horizontalOverflow: overflow.pageX, firstRunOverflow: overflow.mainY }));
} finally {
  socket?.close();
  child?.kill();
  await new Promise((resolve) => setTimeout(resolve, 500));
  await rm(profile, { recursive: true, force: true });
  if (removeDefaultAnalysisAfterRun) await rm(analysisFile, { force: true });
}
