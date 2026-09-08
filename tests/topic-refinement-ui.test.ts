import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TopicRefinementRequest } from "../src/ui/TopicRefinementRequest.js";

const props = {
  language: "ru" as const,
  text: { instruction: "Что уточнить?", instructionPlaceholder: "Поясните", prepare: "Уточнить тему", preparing: "Агент уточняет тему…", cancel: "Отмена" },
  instruction: "Это моё нынешнее ощущение, а не вывод обо всех годах вместе",
  pending: false, ready: false,
  onChange: () => {}, onRefine: () => {}, onCancel: () => {},
};

test("topic clarification uses standard action buttons and a single pending status", () => {
  const idle = renderToStaticMarkup(createElement(TopicRefinementRequest, props));
  const pending = renderToStaticMarkup(createElement(TopicRefinementRequest, { ...props, pending: true }));
  assert.match(idle, /class="actions topic-refinement-actions"/);
  assert.equal((pending.match(/Агент уточняет тему/g) ?? []).length, 1);
  assert.equal((pending.match(/role="status"/g) ?? []).length, 1);
  const button = (html: string) => html.match(/<button[^>]*class="primary"[^>]*>(.*?)<\/button>/)?.[1];
  assert.equal(button(idle), "Уточнить тему");
  assert.equal(button(pending), button(idle), "Waiting does not stretch or duplicate the button label");
  assert.match(pending, /aria-busy="true"/);
  assert.equal((pending.match(/disabled=""/g) ?? []).length, 3, "No edits or duplicate calls while waiting");
  assert.doesNotMatch(idle, /role="status"/);
});

test("completed preview removes waiting and preparation controls but retains the clarification", () => {
  const html = renderToStaticMarkup(createElement(TopicRefinementRequest, { ...props, ready: true }));
  assert.doesNotMatch(html, /role="status"|<button/);
  assert.match(html, /моё нынешнее ощущение/);
  const blank = renderToStaticMarkup(createElement(TopicRefinementRequest, { ...props, instruction: " " }));
  assert.match(blank, /class="primary" disabled=""/);
});
