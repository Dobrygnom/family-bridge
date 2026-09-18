import assert from "node:assert/strict";
import test from "node:test";
import { loginItemSettings, shouldLaunchHidden } from "../src/core/auto-start.js";

test("Electron 44 autostart keeps Windows and macOS launches hidden", () => {
  assert.deepEqual(loginItemSettings("win32", true), { openAtLogin: true, args: ["--hidden"] });
  assert.deepEqual(loginItemSettings("darwin", true), { openAtLogin: true });
  assert.equal(shouldLaunchHidden("win32", true, ["Family Bridge.exe", "--hidden"]), true);
  assert.equal(shouldLaunchHidden("win32", false, ["Family Bridge.exe", "--hidden"]), false);
  assert.equal(shouldLaunchHidden("darwin", true, [], true), true);
  assert.equal(shouldLaunchHidden("darwin", true, [], false), false);
  assert.equal(shouldLaunchHidden("linux", true, ["--hidden"], true), false);
});
