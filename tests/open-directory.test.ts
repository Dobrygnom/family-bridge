import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { exportReportFiles, windowsRevealInvocation } from "../electron/open-directory.js";

test("Windows Explorer receives the exported report as one literal argument", () => {
  const report = "C:\\Users\\test user\\Documents\\Family Bridge Reports\\result.json";
  const invocation = windowsRevealInvocation(report, "C:\\Windows");
  assert.equal(invocation.command, "C:\\Windows\\explorer.exe");
  assert.deepEqual(invocation.args, [`/select,${report}`]);
});

test("report files are copied to the user-facing export folder", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "family-bridge-report-export-"));
  try {
    const source = path.join(root, "internal", "result.json");
    const destination = path.join(root, "Documents", "Family Bridge Reports");
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "readable result", "utf8");
    const exported = await exportReportFiles([source], destination);
    assert.equal(exported, path.join(destination, "result.json"));
    assert.equal(await readFile(exported!, "utf8"), "readable result");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
