import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { isolatedCodexInvocation, codexTaskFailure } from "../src/core/codex-isolation.js";
import { codexReasoningArgs, preferredModelArgs } from "../src/core/codex-model.js";
import type { CodexReasoningEffort } from "../src/core/codex-settings.js";

export async function runPersistentStructuredCodex(input: {
  command: string;
  workspace: string;
  schemaPath: string;
  prompt: string;
  sessionId?: string;
  model?: string | null;
  reasoningEffort: CodexReasoningEffort;
  timeoutMs?: number;
}): Promise<{ value: unknown; sessionId?: string }> {
  await mkdir(input.workspace, { recursive: true });
  const modelArgs = input.model === undefined ? await preferredModelArgs(input.command)
    : input.model ? ["--model", input.model] : [];
  const rawArgs = input.sessionId
    ? ["exec", "resume", ...modelArgs, ...codexReasoningArgs(input.reasoningEffort), "--skip-git-repo-check", "--json", "--output-schema", input.schemaPath, input.sessionId, "-"]
    : ["exec", ...modelArgs, ...codexReasoningArgs(input.reasoningEffort), "--skip-git-repo-check", "-s", "read-only", "--json", "--output-schema", input.schemaPath, "-C", input.workspace, "-"];
  const args = isolatedCodexInvocation(rawArgs);
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, args, {
      cwd: input.workspace,
      windowsHide: true,
      shell: process.platform === "win32" && input.command.toLowerCase().endsWith(".cmd"),
      env: process.env,
    });
    let stdout = "", stderr = "", settled = false;
    const done = (callback: () => void) => { if (!settled) { settled = true; clearTimeout(timeout); callback(); } };
    const timeout = setTimeout(() => { child.kill(); done(() => reject(new Error("Ответ не был подготовлен вовремя. Сообщение сохранено; его можно повторить."))); }, input.timeoutMs ?? 15 * 60_000);
    child.stdin.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") done(() => reject(error)); });
    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.once("error", error => done(() => reject(error)));
    child.on("close", code => done(() => {
      if (code !== 0) { reject(codexTaskFailure("Разговор с психологом", code, stderr || stdout)); return; }
      try {
        let threadId: string | undefined, finalText = "";
        for (const line of stdout.split(/\r?\n/)) {
          if (!line.trim().startsWith("{")) continue;
          const event = JSON.parse(line) as { type?: string; thread_id?: string; item?: { type?: string; text?: string }; message?: string; error?: { message?: string } };
          if (event.type === "thread.started") threadId = event.thread_id;
          if (event.type === "item.completed" && event.item?.type === "agent_message") finalText = event.item.text ?? "";
          if (event.type === "error") throw new Error(event.message ?? event.error?.message ?? "Разговор не выполнен");
        }
        if (!finalText) throw new Error("Психолог не вернул ответ");
        resolve({ value: JSON.parse(finalText), sessionId: input.sessionId ?? threadId });
      } catch (error) { reject(error); }
    }));
    child.stdin.end(input.prompt);
  });
}
