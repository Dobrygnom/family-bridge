import assert from "node:assert/strict";
import test from "node:test";
import { buildInitialPrompt } from "../src/core/codex-runtime.js";

test("agent prompt carries the selected language and lets the app infer style from chat samples", () => {
  const prompt = buildInitialPrompt({
    id: "katya",
    displayName: "Alex",
    ownerName: "Alex",
    peerName: "Sam",
    perspective: "Локальный контекст",
    communicationExamples: '{"message_id":"1","text":"быстро. два вопроса"}',
    language: "cs",
    workspace: "unused",
    schemaPath: "unused",
  }, "Начальное сообщение");

  assert.match(prompt, /Язык сессии: чешском/);
  assert.match(prompt, /Твой владелец — Alex/);
  assert.match(prompt, /Второй агент представляет Sam/);
  assert.match(prompt, /быстро\. два вопроса/);
  assert.match(prompt, /Самостоятельно определи/);
  assert.match(prompt, /Примеры задают только форму речи/);
  assert.match(prompt, /owner_question/);
  assert.match(prompt, /не хватает важного факта/);
});
