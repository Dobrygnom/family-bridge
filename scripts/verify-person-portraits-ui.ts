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
  const originalTopicTitle = await evaluate<string>(`document.querySelector('.topic-approval-copy strong')?.textContent?.trim() ?? ''`);
  assert.ok(originalTopicTitle, "No topic was visible for editing");
  const originalTopicId = await evaluate<string>(`window.familyBridge.getState().then((state) => state.contextAnalysis?.topics.find((item) => item.title === ${JSON.stringify(originalTopicTitle)})?.id ?? '')`);
  assert.ok(originalTopicId, "Visible topic was not found in app state");
  assert.ok(await evaluate<boolean>(`(() => { const button = document.querySelector('.topic-expand'); if (!(button instanceof HTMLElement)) return false; button.click(); return true; })()`));
  assert.ok(await waitFor(async () => await evaluate<boolean>(`[...document.querySelectorAll('.topic-refine button')].some((item) => item.textContent?.trim() === 'Уточнить тему')`) || undefined));
  assert.ok(await evaluate<boolean>(`(() => { const button = [...document.querySelectorAll('.topic-refine button')].find((item) => item.textContent?.trim() === 'Уточнить тему'); if (!(button instanceof HTMLElement)) return false; button.click(); return true; })()`));
  assert.ok(await waitFor(async () => await evaluate<boolean>(`document.querySelector('.topic-edit') instanceof HTMLElement`) || undefined));
  assert.ok(await evaluate<boolean>(`document.querySelector('.topic-refinement-request textarea') instanceof HTMLTextAreaElement`), "Natural-language refinement field is missing");
  const refinementInstruction = "Объясни тему понятнее человеку, который не видел исходный чат. Не добавляй новых фактов.";
  assert.ok(await evaluate<boolean>(`(() => {
    const textarea = document.querySelector('.topic-refinement-request textarea');
    if (!(textarea instanceof HTMLTextAreaElement)) return false;
    const textareaSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    textareaSetter?.call(textarea, ${JSON.stringify(refinementInstruction)});
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`));
  assert.ok(await evaluate<boolean>(`(() => { const button = [...document.querySelectorAll('.topic-refinement-actions button')].find((item) => item.textContent?.trim() === 'Уточнить тему'); if (!(button instanceof HTMLElement)) return false; button.click(); return true; })()`));
  assert.ok(await waitFor(async () => await evaluate<boolean>(`document.querySelector('.topic-preview-card') instanceof HTMLElement`) || undefined, 180_000));
  assert.equal(await evaluate<string>(`document.querySelector('.topic-preview-heading strong')?.textContent?.trim() ?? ''`), "Теперь тема будет выглядеть так");
  const editedTopic = await evaluate<{ title: string; context: string; goal: string; openingQuestion: string }>(`(() => { const paragraphs = [...document.querySelectorAll('.topic-preview-card p')].map((item) => item.textContent?.trim() ?? '').map((item) => item.replace(/^«|»$/g, '')); return { title: document.querySelector('.topic-preview-card h5')?.textContent?.trim() ?? '', context: paragraphs[0] ?? '', goal: paragraphs[1] ?? '', openingQuestion: paragraphs[2] ?? '' }; })()`);
  assert.ok(editedTopic.title && editedTopic.context && editedTopic.goal && editedTopic.openingQuestion, "Refined preview is incomplete");
  const beforeSave = await evaluate<{ unchanged: boolean; queued: boolean; instructionStored: boolean }>(`window.familyBridge.getState().then((state) => { const topic = state.contextAnalysis?.topics.find((item) => item.id === ${JSON.stringify(originalTopicId)}); return { unchanged: topic?.title === ${JSON.stringify(originalTopicTitle)}, queued: state.pendingTopics.includes(${JSON.stringify(editedTopic.title)}), instructionStored: JSON.stringify(state).includes(${JSON.stringify(refinementInstruction)}) }; })`);
  assert.deepEqual(beforeSave, { unchanged: true, queued: false, instructionStored: false }, "Preview changed or shared persisted state before confirmation");
  assert.ok(await waitFor(async () => await evaluate<boolean>(`(() => { const button = [...document.querySelectorAll('.topic-edit-actions button')].find((item) => item.textContent?.trim() === 'Сохранить уточнение'); return button instanceof HTMLButtonElement && !button.disabled; })()`) || undefined));
  assert.ok(await evaluate<boolean>(`(() => { const button = [...document.querySelectorAll('.topic-edit-actions button')].find((item) => item.textContent?.trim() === 'Сохранить уточнение'); if (!(button instanceof HTMLElement)) return false; button.click(); return true; })()`));
  await waitFor(async () => {
    const saved = await evaluate<boolean>(`window.familyBridge.getState().then((state) => state.contextAnalysis?.topics.find((item) => item.id === ${JSON.stringify(originalTopicId)})?.title === ${JSON.stringify(editedTopic.title)})`);
    return saved || undefined;
  });
  const editedState = await evaluate<{ approved: boolean; queued: boolean; reason: string }>(`window.familyBridge.getState().then((state) => { const topic = state.contextAnalysis?.topics.find((item) => item.id === ${JSON.stringify(originalTopicId)}); return { approved: topic?.approved ?? true, queued: state.pendingTopics.includes(${JSON.stringify(editedTopic.title)}), reason: topic?.reason ?? '' }; })`);
  assert.equal(editedState.approved, false, "Editing a topic approved it automatically");
  assert.equal(editedState.queued, false, "Editing a topic shared it automatically");
  assert.ok(editedState.reason.includes(editedTopic.context), "Saved topic does not contain the exact preview context");
  const persistedAnalysis = JSON.parse(await readFile(path.join(memory, "context-analysis.json"), "utf8")) as { topics?: Array<{ id?: string; title?: string }> };
  assert.equal(persistedAnalysis.topics?.find((item) => item.id === originalTopicId)?.title, editedTopic.title, "Refined topic was not persisted to disk");
  console.log(JSON.stringify({ verified: true, packagedVersion: "1.2.3", people: tabCount, ownerObservations: initialObservationCount, editPersisted: true, topicEditPersisted: true, topicEditShared: false, personSwitch: true, horizontalOverflow: overflow.pageX, firstRunOverflow: overflow.mainY }));
} finally {
  socket?.close();
  child?.kill();
  await new Promise((resolve) => setTimeout(resolve, 500));
  await rm(profile, { recursive: true, force: true });
  if (removeDefaultAnalysisAfterRun) await rm(analysisFile, { force: true });
}
