import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

// Exercise the production retry function with virtual time and controlled I/O.
async function harness(failures: number, code = "EPERM") {
  const source = await readFile(new URL("../electron/store.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
  const body = compiled.slice(compiled.indexOf("export async function replaceStateFile"), compiled.indexOf("export class AtomicStore")).replace("export ", "");
  let calls = 0;
  const waits: number[] = [];
  const error = Object.assign(new Error("simulated lock"), { code });
  const replace = vm.runInNewContext(`${body}; replaceStateFile`, {
    rename: async (from: string, to: string) => {
      assert.equal(from, "state.json.tmp"); assert.equal(to, "state.json");
      if (++calls <= failures) throw error;
    },
    delay: async (ms: number) => { waits.push(ms); },
  });
  return { run: () => replace("state.json.tmp", "state.json"), waits, calls: () => calls, error };
}

test("state replacement survives locks longer than the old 310ms window", async () => {
  for (const code of ["EPERM", "EBUSY"]) {
    const h = await harness(8, code);
    await h.run();
    assert.equal(h.calls(), 9);
    assert.ok(h.waits.reduce((a, b) => a + b, 0) > 310);
    assert.ok(h.waits.every(ms => ms <= 500));
  }
});

test("persistent lock stops after a bounded 10s without reporting success", async () => {
  const h = await harness(Infinity);
  await assert.rejects(h.run(), error => error === h.error);
  assert.equal(h.waits.reduce((a, b) => a + b, 0), 10_000);
});

test("unrelated write errors are not hidden or retried", async () => {
  const h = await harness(Infinity, "ENOSPC");
  await assert.rejects(h.run(), error => error === h.error);
  assert.equal(h.calls(), 1);
  assert.deepEqual(h.waits, []);
});
