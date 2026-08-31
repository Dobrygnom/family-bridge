import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexHistoryClient, extractUserMessages } from "../src/core/codex-history.js";
import { findWindowsCodexExecutable, selectWindowsCodexCommand } from "../src/core/codex-runtime.js";

test("context export keeps only user text messages", () => {
  const messages = extractUserMessages({ turns: [{ id: "turn-1", createdAt: 1_788_166_149, items: [
    { id: "user-1", type: "userMessage", content: [{ type: "text", text: "Мой текст" }] },
    { id: "agent-1", type: "agentMessage", text: "Ответ агента" },
  ] }] });
  assert.deepEqual(messages, [{ message_id: "user-1", created_at: "2026-08-31T08:49:09.000Z", text: "Мой текст" }]);
});

test("Windows command resolution ignores the extensionless npm shim", () => {
  assert.equal(selectWindowsCodexCommand([
    "C:\\Users\\owner\\AppData\\Roaming\\npm\\codex",
    "C:\\Users\\owner\\AppData\\Roaming\\npm\\codex.cmd",
  ]), "C:\\Users\\owner\\AppData\\Roaming\\npm\\codex.cmd");
});

test("Windows command resolution finds the Codex Desktop executable outside PATH", async (context) => {
  const localAppData = await mkdtemp(path.join(os.tmpdir(), "family-bridge-codex-"));
  context.after(() => rm(localAppData, { recursive: true, force: true }));
  const executable = path.join(localAppData, "OpenAI", "Codex", "bin", "version-id", "codex.exe");
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, "");
  assert.equal(findWindowsCodexExecutable(localAppData), executable);
});

test("a missing Codex executable rejects without crashing the process", async () => {
  const client = new CodexHistoryClient("C:\\definitely-missing\\codex.exe");
  await assert.rejects(client.listThreads(), /ENOENT|not found/i);
});
