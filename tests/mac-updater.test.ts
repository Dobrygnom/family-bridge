import assert from "node:assert/strict";
import test from "node:test";
import { findMacAppBundle, isVersionNewer, normalizeVersion, selectMacAsset } from "../electron/mac-updater.js";

test("compares release versions without treating equal or older releases as updates", () => {
  assert.equal(normalizeVersion("v0.3.11"), "0.3.11");
  assert.equal(isVersionNewer("0.3.7", "v0.3.11"), true);
  assert.equal(isVersionNewer("0.3.11", "0.3.11"), false);
  assert.equal(isVersionNewer("0.3.11", "0.3.10"), false);
  assert.equal(isVersionNewer("0.3.11", "0.4.0"), true);
});

test("selects only the exact architecture asset with a GitHub URL and SHA-256 digest", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const release = {
    tag_name: "v0.3.11",
    draft: false,
    prerelease: false,
    assets: [
      { name: "Family-Bridge-0.3.11-arm64.zip", browser_download_url: "https://github.com/Dobrygnom/family-bridge/releases/download/v0.3.11/Family-Bridge-0.3.11-arm64.zip", digest },
      { name: "Family-Bridge-0.3.11-x64.zip", browser_download_url: "https://github.com/Dobrygnom/family-bridge/releases/download/v0.3.11/Family-Bridge-0.3.11-x64.zip", digest },
    ],
  };
  assert.equal(selectMacAsset(release, "arm64").asset.name, "Family-Bridge-0.3.11-arm64.zip");
  assert.equal(selectMacAsset(release, "x64").asset.name, "Family-Bridge-0.3.11-x64.zip");
  assert.throws(() => selectMacAsset({ ...release, assets: [{ ...release.assets[0], digest: null }] }, "arm64"), /SHA-256/);
  assert.throws(() => selectMacAsset({ ...release, assets: [{ ...release.assets[0], browser_download_url: "https://example.com/update.zip" }] }, "arm64"), /недопустимый адрес/);
});

test("finds the enclosing macOS application bundle from its executable", () => {
  assert.equal(findMacAppBundle("/Applications/Family Bridge.app/Contents/MacOS/Family Bridge"), "/Applications/Family Bridge.app");
  assert.equal(findMacAppBundle("/usr/local/bin/family-bridge"), undefined);
});
