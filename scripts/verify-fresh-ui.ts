import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const port = process.env.FAMILY_BRIDGE_CDP_PORT ?? "9224";
const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
let ownedProcess: ChildProcess | undefined;
let ownedProfile: string | undefined;
let endpoint: string | undefined;
for (let attempt = 0; attempt < 120 && !endpoint; attempt += 1) {
  try {
    const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json()) as Array<{ type?: string; webSocketDebuggerUrl?: string }>;
    endpoint = pages.find((page) => page.type === "page")?.webSocketDebuggerUrl;
  } catch { /* launch a packaged renderer below, or wait for it */ }
  if (endpoint) break;
  if (attempt === 0) {
    ownedProfile = await mkdtemp(path.join(os.tmpdir(), "family-bridge-fresh-ui-"));
    const executable = path.resolve(process.argv[2] || "release/win-unpacked/Family Bridge.exe");
    ownedProcess = spawn(executable, [`--remote-debugging-port=${port}`], {
      env: { ...process.env, FAMILY_BRIDGE_E2E_ALLOW_SECOND_INSTANCE: "1", FAMILY_BRIDGE_E2E_USER_DATA: ownedProfile },
      windowsHide: true,
      stdio: "ignore",
    });
  }
  await delay(250);
}
assert.ok(endpoint, "Fresh Family Bridge renderer was not exposed through CDP");

const socket = new WebSocket(endpoint);
await new Promise<void>((resolve, reject) => {
  socket.addEventListener("open", () => resolve(), { once: true });
  socket.addEventListener("error", () => reject(new Error("Could not connect to the fresh Family Bridge renderer")), { once: true });
});

let nextId = 1;
async function evaluate<T>(expression: string): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    const listener = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: { result?: { value?: T }; exceptionDetails?: unknown }; error?: { message?: string } };
      if (message.id !== id) return;
      socket.removeEventListener("message", listener);
      if (message.error || message.result?.exceptionDetails) reject(new Error(message.error?.message ?? "Renderer evaluation failed"));
      else resolve(message.result?.result?.value as T);
    };
    socket.addEventListener("message", listener);
    socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
  });
}

let bridgeReady = false;
for (let attempt = 0; attempt < 120 && !bridgeReady; attempt += 1) {
  try { bridgeReady = await evaluate<boolean>("typeof window.familyBridge?.getState === 'function'"); }
  catch { /* preload and renderer are still starting */ }
  if (!bridgeReady) await delay(250);
}
assert.equal(bridgeReady, true, "Fresh Family Bridge preload did not initialize");

const state = await evaluate<{ onboardingComplete: boolean; hasContext: boolean; hasAnalysis: boolean }>(`window.familyBridge.getState().then((state) => ({ onboardingComplete: state.onboardingComplete, hasContext: Boolean(state.context), hasAnalysis: Boolean(state.contextAnalysis) }))`);
assert.deepEqual(state, { onboardingComplete: false, hasContext: false, hasAnalysis: false });
let navigation: string[] = [];
for (let attempt = 0; attempt < 120 && navigation.length < 5; attempt += 1) {
  navigation = await evaluate<string[]>(`[...document.querySelectorAll('nav button')].map((button) => button.textContent?.trim() ?? '')`);
  if (navigation.length < 5) await delay(250);
}
assert.deepEqual(navigation, ["Первый запуск", "Исходный чат и темы", "Что знает мой агент", "Разговоры", "Настройки"]);
await evaluate<boolean>(`(() => { const button = document.querySelector('nav button'); if (!(button instanceof HTMLElement)) return false; button.click(); return true; })()`);
const mainText = await evaluate<string>(`document.querySelector('main')?.innerText ?? ''`);
assert.match(mainText, /Подготовка к первому разговору/);
assert.match(mainText, /Где будет работать ваш помощник/);
assert.match(mainText, /Мой ChatGPT/);
assert.match(mainText, /Доверенный компьютер/);
assert.doesNotMatch(mainText, /Темы проверены — перейти к подключению|Создать приглашение|Подключиться/);
const overflow = await evaluate<{ pageX: number; mainY: number }>(`({ pageX: document.documentElement.scrollWidth - document.documentElement.clientWidth, mainY: (() => { const main = document.querySelector('main'); return main ? main.scrollHeight - main.clientHeight : 1; })() })`);
assert.ok(overflow.pageX <= 1, `Fresh first run has horizontal overflow: ${overflow.pageX}px`);
assert.ok(overflow.mainY <= 1, `Fresh first run scrolls as a whole: ${overflow.mainY}px`);
const openedSettings = await evaluate<boolean>(`(() => { const button = [...document.querySelectorAll('nav button')].find((item) => item.textContent?.trim() === 'Настройки'); if (!(button instanceof HTMLElement)) return false; button.click(); return true; })()`);
assert.equal(openedSettings, true, "Could not open update settings");
const updateText = await evaluate<string>(`document.querySelector('.update-card')?.textContent ?? ''`);
assert.match(updateText, /Установлена версия 2\.1\.0/);
const settingsText = await evaluate<string>(`document.querySelector('main')?.innerText ?? ''`);
assert.match(settingsText, /Доверенный компьютер/);
assert.match(settingsText, /Этот компьютер помогает другим/);
assert.match(settingsText, /Использовать доверенный компьютер/);
assert.match(settingsText, /gpt-5\.6-sol/);
console.log(JSON.stringify({ freshProfile: true, navigation, firstActions: ["my-chatgpt", "trusted-computer"], overflow, updateStatus: true, computeSwitch: true }));
socket.close();
if (ownedProcess && ownedProcess.exitCode === null) {
  const exited = new Promise<void>(resolve => ownedProcess!.once("exit", () => resolve()));
  ownedProcess.kill();
  await Promise.race([exited, delay(5_000)]);
  if (ownedProcess.exitCode === null) ownedProcess.kill("SIGKILL");
}
if (ownedProfile) await rm(ownedProfile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
