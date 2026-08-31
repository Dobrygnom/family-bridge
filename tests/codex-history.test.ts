import assert from "node:assert/strict";
import test from "node:test";
import { extractUserMessages } from "../src/core/codex-history.js";

test("context export keeps only user text messages", () => {
  const messages = extractUserMessages({ turns: [{ id: "turn-1", createdAt: 1_788_166_149, items: [
    { id: "user-1", type: "userMessage", content: [{ type: "text", text: "Мой текст" }] },
    { id: "agent-1", type: "agentMessage", text: "Ответ агента" },
  ] }] });
  assert.deepEqual(messages, [{ message_id: "user-1", created_at: "2026-08-31T08:49:09.000Z", text: "Мой текст" }]);
});
