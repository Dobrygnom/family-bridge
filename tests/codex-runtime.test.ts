import assert from "node:assert/strict";
import test from "node:test";
import { buildInitialPrompt } from "../src/core/codex-runtime.js";

test("agent prompt carries the selected language and communication style", () => {
  const prompt = buildInitialPrompt({
    id: "katya",
    displayName: "Кати",
    perspective: "Локальный контекст",
    communicationStyle: "Короткие прямые фразы, мягкий юмор.",
    language: "cs",
    workspace: "unused",
    schemaPath: "unused",
  }, "Начальное сообщение");

  assert.match(prompt, /Язык сессии: чешском/);
  assert.match(prompt, /Короткие прямые фразы, мягкий юмор/);
  assert.match(prompt, /не переноси факты из примеров стиля/);
});
