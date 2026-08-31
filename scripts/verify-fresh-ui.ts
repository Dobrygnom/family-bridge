import assert from "node:assert/strict";

const port = process.env.FAMILY_BRIDGE_CDP_PORT ?? "9224";
const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json()) as Array<{ type?: string; webSocketDebuggerUrl?: string }>;
const endpoint = pages.find((page) => page.type === "page")?.webSocketDebuggerUrl;
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

const state = await evaluate<{ onboardingComplete: boolean; hasContext: boolean; hasAnalysis: boolean }>(`window.familyBridge.getState().then((state) => ({ onboardingComplete: state.onboardingComplete, hasContext: Boolean(state.context), hasAnalysis: Boolean(state.contextAnalysis) }))`);
assert.deepEqual(state, { onboardingComplete: false, hasContext: false, hasAnalysis: false });
const navigation = await evaluate<string[]>(`[...document.querySelectorAll('nav button')].map((button) => button.textContent?.trim() ?? '')`);
assert.deepEqual(navigation, ["Первый запуск", "Исходный чат и темы", "Итоги разговоров", "Имя и автозапуск"]);
const mainText = await evaluate<string>(`document.querySelector('main')?.innerText ?? ''`);
assert.match(mainText, /Подготовка к первому разговору/);
assert.match(mainText, /1\. Выберите базовый чат/);
assert.match(mainText, /Выбрать чат/);
assert.doesNotMatch(mainText, /Темы проверены — перейти к подключению|Создать приглашение|Подключиться/);
const overflow = await evaluate<{ pageX: number; mainY: number }>(`({ pageX: document.documentElement.scrollWidth - document.documentElement.clientWidth, mainY: (() => { const main = document.querySelector('main'); return main ? main.scrollHeight - main.clientHeight : 1; })() })`);
assert.ok(overflow.pageX <= 1, `Fresh first run has horizontal overflow: ${overflow.pageX}px`);
assert.ok(overflow.mainY <= 1, `Fresh first run scrolls as a whole: ${overflow.mainY}px`);
console.log(JSON.stringify({ freshProfile: true, navigation, firstAction: "choose-chat", overflow }));
socket.close();
