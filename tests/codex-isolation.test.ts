import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { isolatedCodexInvocation, codexTaskFailure } from "../src/core/codex-isolation.js";

test("initial and resumed text workers isolate configuration without moving auth or stdin", () => {
  for (const invocation of [["exec", "--output-schema", "schema.json", "-"], ["exec", "resume", "--json", "thread-id", "-"]]) {
    const args = isolatedCodexInvocation(invocation);
    assert.equal(args[0], "exec");
    assert.equal(args[1], "--ignore-user-config");
    assert.deepEqual(args.slice(-invocation.length + 1), invocation.slice(1));
    for (const flag of ["mcp_servers={}", "features.plugins=false", "features.apps=false", "features.hooks=false", "features.browser_use=false", "features.computer_use=false", "features.shell_tool=false", "project_doc_max_bytes=0"]) assert.ok(args.includes(flag));
    assert.equal(args.at(-1), "-");
    assert.doesNotMatch(JSON.stringify(args), /CODEX_HOME|auth\.json/);
  }
});

test("all four model generation paths use isolation at the spawn boundary", async () => {
  for (const name of ["codex-runtime", "context-analysis", "person-portraits", "topic-refinement"]) {
    const source = await readFile(new URL(`../src/core/${name}.ts`, import.meta.url), "utf8");
    assert.match(source, /spawn\([^\n]*isolatedCodexInvocation\(/, name);
  }
});

test("process progress and private CLI output never become user-facing errors", () => {
  const progress = '{"type":"thread.started","thread_id":"private-id"}\n{"type":"turn.started"}\nprivate token';
  const error = codexTaskFailure("Разбор исходного чата", 1, progress);
  assert.match(error.message, /Разбор исходного чата не завершён/);
  assert.doesNotMatch(error.message, /thread|turn|private|token/);
  assert.equal((error as any).code, "CODEX_PROCESS_EXIT");
  const unsupported = codexTaskFailure("Разбор", 2, "error: unexpected argument '--ignore-user-config' found");
  assert.equal((unsupported as any).code, "CODEX_ISOLATION_UNSUPPORTED");
  assert.match(unsupported.message, /обновите Codex/);
});
