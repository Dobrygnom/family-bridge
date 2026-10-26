import assert from "node:assert/strict";
import test from "node:test";
import { isWindowsInstallerParent, windowsProcessImage } from "../src/core/windows-update-handoff.js";

test("updated launch waits only for the real installer, never Explorer", () => {
  assert.equal(windowsProcessImage('"explorer.exe","32428","Console","1","120,000 K"'), "explorer.exe");
  assert.equal(isWindowsInstallerParent('"explorer.exe","32428","Console","1","120,000 K"'), false);
  assert.equal(isWindowsInstallerParent('"Family-Bridge-2.1.12-x64.exe","100","Console","1","1,000 K"'), true);
  assert.equal(isWindowsInstallerParent('"Family Bridge Setup.exe","100","Console","1","1,000 K"'), true);
  assert.equal(isWindowsInstallerParent('INFO: No tasks are running which match the specified criteria.'), false);
});
