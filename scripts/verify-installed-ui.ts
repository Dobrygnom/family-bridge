import assert from "node:assert/strict";

const port = process.env.FAMILY_BRIDGE_CDP_PORT ?? "9223";
const expectedProject = process.env.FAMILY_BRIDGE_EXPECT_PROJECT ?? "Улучшаем Форму";
const expectedChat = process.env.FAMILY_BRIDGE_EXPECT_CHAT ?? "Задать вопросы после расставания";
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
assert.ok(navigation.includes("Исходный чат и темы"), "Source chat and topics is not a separate navigation item");
assert.deepEqual(navigation, ["Первый запуск", "Исходный чат и темы", "Итоги разговоров", "Имя и автозапуск"]);
const overviewText = await evaluate<string>(`document.querySelector('main')?.innerText ?? ''`);
assert.match(overviewText, /Подготовка к первому разговору/);
assert.match(overviewText, /Проверьте людей и темы/);
assert.match(overviewText, /Темы проверены — перейти к подключению/);
assert.doesNotMatch(overviewText, /СОЕДИНЕНИЕ|Создать приглашение|Создать новый код/);
assert.doesNotMatch(overviewText, /Быстрый demo|Запустить через Codex|Поговорить с агентом партнёра/);
const appSummary = await evaluate<{ project?: string; chat?: string; contextStatus?: string; analysisStatus?: string; people: number; topics: number; approved: number; grouped: number[] }>(`window.familyBridge.getState().then((state) => ({ project: state.context?.project, chat: state.context?.title, contextStatus: state.context?.status, analysisStatus: state.contextAnalysis?.status, people: state.contextAnalysis?.people.length ?? 0, topics: state.contextAnalysis?.topics.length ?? 0, approved: state.contextAnalysis?.topics.filter((topic) => topic.approved).length ?? 0, grouped: (state.contextAnalysis?.people ?? []).map((person) => state.contextAnalysis?.topics.filter((topic) => topic.discussWithPersonId === person.id).length ?? 0) }))`);
assert.equal(appSummary.project, expectedProject);
assert.equal(appSummary.chat, expectedChat);
assert.equal(appSummary.contextStatus, "ready");
assert.equal(appSummary.analysisStatus, "ready");
assert.ok(appSummary.people > 0, "No people were identified");
assert.ok(appSummary.topics > 0, "No topics were identified");
assert.equal(appSummary.approved, 0, "Topics were approved without the owner's action");
assert.equal(appSummary.grouped.reduce((sum, count) => sum + count, 0), appSummary.topics, "Topic grouping does not cover every topic exactly once");
const compactRows = await evaluate<Array<{ height: number; text: string }>>(`[...document.querySelectorAll('.topic-row-main')].map((row) => ({ height: row.getBoundingClientRect().height, text: row.textContent?.trim() ?? '' }))`);
assert.ok(compactRows.length > 0, "No compact topic rows were rendered");
assert.ok(compactRows.every((row) => row.height <= 64), "A collapsed topic row is too tall");
const overflow = await evaluate<{ pageX: number; mainY: number }>(`({ pageX: document.documentElement.scrollWidth - document.documentElement.clientWidth, mainY: (() => { const main = document.querySelector('main'); return main ? main.scrollHeight - main.clientHeight : 1; })() })`);
assert.ok(overflow.pageX <= 1, `The installed app has horizontal page overflow: ${overflow.pageX}px`);
assert.ok(overflow.mainY <= 1, `The first-run screen scrolls as a whole: ${overflow.mainY}px`);
const searchResult = await evaluate<{ filtered: number; restored: number }>(`(() => { const input = document.querySelector('.registry-controls input'); const firstTitle = document.querySelector('.topic-approval span')?.textContent?.trim() ?? ''; if (!(input instanceof HTMLInputElement) || !firstTitle) return { filtered: 0, restored: 0 }; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set; setter?.call(input, firstTitle.slice(0, 8)); input.dispatchEvent(new Event('input', { bubbles: true })); const filtered = document.querySelectorAll('.topic-row-main').length; setter?.call(input, ''); input.dispatchEvent(new Event('input', { bubbles: true })); return { filtered, restored: document.querySelectorAll('.topic-row-main').length }; })()`);
assert.ok(searchResult.filtered > 0, "Topic search did not find the selected topic");
assert.equal(searchResult.restored, compactRows.length, "Clearing topic search did not restore the list");
const expanded = await evaluate<boolean>(`(() => { const button = document.querySelector('.topic-expand'); if (!(button instanceof HTMLElement)) return false; button.click(); return true; })()`);
assert.equal(expanded, true, "Could not expand a topic row");
const detailText = await evaluate<string>(`document.querySelector('.topic-row-detail')?.textContent ?? ''`);
assert.match(detailText, /О ком/);
assert.match(detailText, /Обсудить с/);
await evaluate<boolean>(`(() => { const button = document.querySelector('.topic-expand'); if (!(button instanceof HTMLElement)) return false; button.click(); return true; })()`);
const clicked = await evaluate<boolean>(`(() => { const button = [...document.querySelectorAll('nav button')].find((item) => item.textContent?.trim() === 'Исходный чат и темы'); if (!(button instanceof HTMLElement)) return false; button.click(); return true; })()`);
assert.equal(clicked, true, "Could not open the Context screen");
await new Promise((resolve) => setTimeout(resolve, 4_000));
const mainText = await evaluate<string>(`document.querySelector('main')?.innerText ?? ''`);
assert.ok(mainText.includes(expectedProject));
assert.ok(mainText.includes(expectedChat));
assert.match(mainText, /ЛЮДИ И ТЕМЫ/);
assert.match(mainText, /Темы для/);
assert.match(mainText, /Разрешить безопасные/);
assert.doesNotMatch(mainText, /ПОВЕСТКА|СОЕДИНЕНИЕ|ЖИВОЙ ДИАЛОГ|РЕЗУЛЬТАТ/);
assert.doesNotMatch(mainText, /routed-topic/);
assert.doesNotMatch(mainText, /ENOENT|JavaScript error/i);
await evaluate<boolean>(`(() => { const button = [...document.querySelectorAll('nav button')].find((item) => item.textContent?.trim() === 'Первый запуск'); if (!(button instanceof HTMLElement)) return false; button.click(); return true; })()`);
console.log(JSON.stringify({ navigation, onboarding: true, compactTopicRows: compactRows.length, contextScreen: true, project: expectedProject, chat: expectedChat, people: appSummary.people, topics: appSummary.topics, grouped: appSummary.grouped }));
socket.close();
