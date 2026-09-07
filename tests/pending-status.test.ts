import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { PendingStatus } from "../src/ui/PendingStatus.js";
import { ReportContinuation } from "../src/ui/ReportContinuation.js";
import type { AppState } from "../src/global.js";

test("pending work has an animated accessible indicator, a real label and no fake percentage", () => {
  const html = renderToStaticMarkup(createElement(PendingStatus, { language: "ru", children: "Готовим уточнение…" }));
  assert.match(html, /role="status"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /spin/);
  assert.match(html, /Готовим уточнение/);
  assert.doesNotMatch(html, /%/);
  const css = readFileSync(new URL("../src/ui/styles.css", import.meta.url), "utf8");
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /\.spin, \.topic-preview-card \{ animation: none; \}/);
});

test("continuation animates preparing and waiting, but stops on completion or failure", () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { value: {}, configurable: true });
  try {
  for (const status of ["starting", "waiting", "complete", "error"] as const) {
    const state = { remote: { configured: true, peerVersion: "1.2.3" }, continuationStates: [{ id: "child", parentReportId: "parent", status }] } as AppState;
    const html = renderToStaticMarkup(createElement(ReportContinuation, { reportId: "parent", state, language: "ru", onState: () => {}, dictationBusy: false, onDictationBusy: () => {} }));
    assert.equal(html.includes('class="pending-status"'), status === "starting" || status === "waiting");
    if (status === "starting") assert.match(html, /Готовим уточнение/);
    if (status === "waiting") assert.match(html, /Ждём продолжения/);
    if (status === "error") assert.match(html, /Повторить отправку/);
  }
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
