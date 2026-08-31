import assert from "node:assert/strict";

const port = process.env.FAMILY_BRIDGE_CDP_PORT ?? "9223";
const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json()) as Array<{ type?: string; webSocketDebuggerUrl?: string }>;
const endpoint = pages.find((page) => page.type === "page")?.webSocketDebuggerUrl;
assert.ok(endpoint, "Family Bridge renderer was not exposed through CDP");

const socket = new WebSocket(endpoint);
await new Promise<void>((resolve, reject) => {
  socket.addEventListener("open", () => resolve(), { once: true });
  socket.addEventListener("error", () => reject(new Error("Could not connect to the Family Bridge renderer")), { once: true });
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

const navigation = await evaluate<string[]>(`[...document.querySelectorAll('nav button')].map((button) => button.textContent?.trim() ?? '')`);
assert.ok(navigation.includes("Контекст"), "Context is not a separate navigation item");
const clicked = await evaluate<boolean>(`(() => { const button = [...document.querySelectorAll('nav button')].find((item) => item.textContent?.trim() === 'Контекст'); if (!(button instanceof HTMLElement)) return false; button.click(); return true; })()`);
assert.equal(clicked, true, "Could not open the Context screen");
await new Promise((resolve) => setTimeout(resolve, 4_000));
const mainText = await evaluate<string>(`document.querySelector('main')?.innerText ?? ''`);
assert.match(mainText, /Улучшаем Форму/);
assert.match(mainText, /Задать вопросы после расставания/);
assert.doesNotMatch(mainText, /ПОВЕСТКА|СОЕДИНЕНИЕ|ЖИВОЙ ДИАЛОГ|РЕЗУЛЬТАТ/);
assert.doesNotMatch(mainText, /ENOENT|JavaScript error/i);
console.log(JSON.stringify({ navigation, contextScreen: true, project: "Улучшаем Форму", chat: "Задать вопросы после расставания" }));
socket.close();
