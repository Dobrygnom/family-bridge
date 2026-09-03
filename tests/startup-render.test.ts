import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "../src/ui/App.js";
import { loadSavedState } from "../src/ui/load-state.js";

test("unhydrated renderer shows loading, never a fake first run or completed preparation", () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "window", { value: {}, configurable: true });
  Object.defineProperty(globalThis, "localStorage", { value: { getItem: () => null }, configurable: true });
  try {
    const html = renderToStaticMarkup(createElement(App));
    assert.match(html, /Открываем сохранённые данные/);
    assert.doesNotMatch(html, /Первый запуск|Собираем итоговые рекомендации|Подготовка к первому/);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window");
    if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage); else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("missing IPC handlers and hung backends produce an error instead of fake defaults", async () => {
  await assert.rejects(loadSavedState(() => Promise.reject(new Error("No handler"))), /No handler/);
  await assert.rejects(loadSavedState(() => new Promise(() => undefined), 10), /unavailable/);
  assert.deepEqual(await loadSavedState(async () => ({ onboardingComplete: true })), { onboardingComplete: true });
});
