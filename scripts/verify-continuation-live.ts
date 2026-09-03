import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexCliAgent, defaultCodexCommand } from "../src/core/codex-runtime.js";
import { continuationPrompt, incomingContinuationPrompt, type SharedMessage } from "../src/core/continuation.js";

// Explicit opt-in smoke test: synthetic context only, two real Codex generations.
const directory = await mkdtemp(path.join(os.tmpdir(), "fb-live-continuation-"));
try {
  const history: SharedMessage[] = [{ from: "dima", text: "Как нам договариваться о звонках?" }, { from: "katya", text: "Давай заранее согласовывать время." }];
  const common = { schemaPath: path.resolve("schemas/agent-response.schema.json"), codexCommand: defaultCodexCommand(), language: "ru" as const };
  const first = new CodexCliAgent({ ...common, id: "dima", displayName: "Алексей", ownerName: "Алексей", peerName: "Марина", perspective: "Мне нужен понятный пример того, что значит заранее согласовывать звонки.", communicationExamples: "Я не совсем понял. Можешь на примере объяснить?", workspace: path.join(directory, "first") });
  const second = new CodexCliAgent({ ...common, id: "katya", displayName: "Марина", ownerName: "Марина", peerName: "Алексей", perspective: "Я предпочитаю договориться о вечернем звонке утром или хотя бы за час. Это пожелание, не обещание доступности.", communicationExamples: "Мне удобнее утром решить, созвонимся ли вечером. Если что-то изменится, напишу.", workspace: path.join(directory, "second") });
  const question = await first.start(continuationPrompt("Звонки", history, "Попроси пояснить, что значит заранее: за день, утром или за час. Хочу пример."));
  assert.equal(question.status, "continue");
  assert.ok(question.message_to_peer.trim());
  const answer = await second.start(incomingContinuationPrompt(history, question.message_to_peer));
  assert.ok(answer.message_to_peer.trim());
  assert.notEqual(answer.status, "paused");
  assert.match(answer.message_to_peer, /утр|час/i);
  console.log(JSON.stringify({ realCodex: true, syntheticData: true, question: question.message_to_peer, answer: answer.message_to_peer, status: answer.status }));
} finally { await rm(directory, { recursive: true, force: true }); }
