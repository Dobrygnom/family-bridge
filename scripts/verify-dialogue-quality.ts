import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexCliAgent, defaultCodexCommand, hasRoleVoiceViolation } from "../src/core/codex-runtime.js";
import { preferredCodexModel } from "../src/core/codex-model.js";
import { conversationOpeningPrompt } from "../src/core/conversation-quality.js";

// Opt-in live evaluation. Synthetic people, no real profiles or partner transport.
const root = await mkdtemp(path.join(os.tmpdir(), "fb-dialogue-quality-"));
try {
  const command = defaultCodexCommand();
  const model = await preferredCodexModel(command);
  const common = { codexCommand: command, schemaPath: path.resolve("schemas/agent-response.schema.json"), language: "ru" as const };
  const one = new CodexCliAgent({ ...common, id: "dima", displayName: "Алексей", ownerName: "Алексей", peerName: "Марина", workspace: path.join(root, "one"),
    perspective: "Вчера после работы хотел поговорить с Мариной, она ответила поздно. Я воспринял это как отсутствие интереса, но не знаю причину. Мне не нужен график контроля, хочется чувствовать, что ей тоже хочется общаться.", communicationExamples: "Слушай, я не про расписание. Я просто скучаю. Мне хочется понимать, что ты тоже хочешь поговорить." });
  const two = new CodexCliAgent({ ...common, id: "katya", displayName: "Марина", ownerName: "Марина", peerName: "Алексей", workspace: path.join(root, "two"),
    perspective: "Вчера после работы была очень уставшей и уснула. Хочу общаться с Алексеем, но иногда не могу сразу отвечать. Предпочитаю спонтанные звонки, не хочу обязательных ежедневных отчётов. Могу сообщать, что выдохлась, если замечу, что он ждёт.", communicationExamples: "Я вчера просто вырубилась. Мне правда хочется с тобой болтать, но не всегда есть силы сразу ответить." });
  let current = await one.start(conversationOpeningPrompt("Алексей", "Что для нас значит поздний ответ", { context: "Вчера вечером ответ пришёл поздно, и я почувствовал себя ненужным.", goal: "Понять, как ты это видишь, без введения контроля.", openingQuestion: "Что у тебя вчера было?" }));
  const turns = [{ name: "Алексей", response: current }];
  for (let index = 1; index < 4; index++) {
    const agent = index % 2 ? two : one;
    current = index === 1 ? await agent.start(current.message_to_peer) : await agent.respond(current.message_to_peer);
    turns.push({ name: index % 2 ? "Марина" : "Алексей", response: current });
  }
  assert.equal(turns[0].response.status, "continue");
  assert.equal(turns[1].response.status, "continue");
  for (const turn of turns) {
    assert.ok(turn.response.message_to_peer.trim());
    assert.equal(turn.response.owner_question, "");
    assert.equal(hasRoleVoiceViolation(turn.response, turn.name, turn.name === "Алексей" ? "Марина" : "Алексей"), false);
  }
  assert.match(turns[1].response.message_to_peer, /устал|выруб|уснул|сил|спал/i);
  console.log(JSON.stringify({ model: model ?? "client-default", turns: turns.map((turn) => ({ name: turn.name, text: turn.response.message_to_peer, status: turn.response.status })) }, null, 2));
} finally { await rm(root, { recursive: true, force: true }); }
