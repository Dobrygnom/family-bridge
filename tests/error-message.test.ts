import assert from "node:assert/strict";
import test from "node:test";
import { errorMessage } from "../src/core/error-message.js";

test("server error objects and IPC errors retain their readable message", () => {
  assert.equal(errorMessage({ code: "42501", message: "Нет доступа к подключению", details: null }), "Нет доступа к подключению");
  assert.equal(errorMessage({ error: { message: "Сервер временно недоступен" } }), "Сервер временно недоступен");
  assert.equal(errorMessage(new Error("Error invoking remote method 'bridge:pair': Error: Нет подключения")), "Нет подключения");
  assert.equal(errorMessage("Обычный текст"), "Обычный текст");
});

test("unusable, serialized or cyclic error objects never become object Object", () => {
  const cycle: any = {}; cycle.cause = cycle;
  for (const value of [{}, cycle, "[object Object]", new Error("Error invoking remote method 'bridge:pair': [object Object]"), null, 42])
    assert.equal(errorMessage(value, "Не удалось выполнить действие."), "Не удалось выполнить действие.");
  assert.equal(errorMessage({ message: { text: "not an error field" }, cause: new Error("Причина") }), "Причина");
});
