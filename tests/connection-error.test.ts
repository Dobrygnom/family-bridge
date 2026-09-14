import assert from "node:assert/strict";
import test from "node:test";
import { clearRecoveredConnectionError } from "../src/ui/connection-error.js";

test("successful reconnection clears stale connection authorization errors", () => {
  const messages = [
    "Не удалось восстановить авторизацию подключения. Прежняя пара сохранена; новая учётная запись не создаётся.",
    "Нет действующей авторизации подключения. Прежняя пара сохранена.",
    "Текущая авторизация не даёт доступа к сохранённой паре. Подключение не сброшено.",
  ];
  for (const message of messages) assert.equal(clearRecoveredConnectionError(message, true), "");
});

test("connection errors remain visible until recovery and unrelated errors are never cleared", () => {
  const connection = "Не удалось восстановить авторизацию подключения. Прежняя пара сохранена; новая учётная запись не создаётся.";
  assert.equal(clearRecoveredConnectionError(connection, false), connection);
  assert.equal(clearRecoveredConnectionError("Не удалось сохранить черновик", true), "Не удалось сохранить черновик");
});
