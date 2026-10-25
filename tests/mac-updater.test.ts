import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { downloadAndVerify, findMacAppBundle, isVersionNewer, normalizeVersion, selectMacAsset, shouldReplacePreparedUpdate } from "../electron/mac-updater.js";

test("compares release versions without treating equal or older releases as updates", () => {
  assert.equal(normalizeVersion("v0.3.11"), "0.3.11");
  assert.equal(isVersionNewer("0.3.7", "v0.3.11"), true);
  assert.equal(isVersionNewer("0.3.11", "0.3.11"), false);
  assert.equal(isVersionNewer("0.3.11", "0.3.10"), false);
  assert.equal(isVersionNewer("0.3.11", "0.4.0"), true);
  assert.equal(shouldReplacePreparedUpdate("1.2.43", "1.2.44"), true);
  assert.equal(shouldReplacePreparedUpdate("1.2.44", "1.2.44"), false);
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

test("resumes a partial macOS update with an HTTP range and verifies the complete archive", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "family-bridge-mac-update-"));
  const destination = path.join(directory, "update.partial");
  const complete = Buffer.from("a complete update archive");
  const partial = complete.subarray(0, 7);
  await writeFile(destination, partial);
  let range = "";
  const asset = {
    name: "Family-Bridge-9.9.9-arm64.zip",
    browser_download_url: "https://github.com/Dobrygnom/family-bridge/releases/download/v9.9.9/Family-Bridge-9.9.9-arm64.zip",
    digest: `sha256:${createHash("sha256").update(complete).digest("hex")}`,
    size: complete.length,
  };
  try {
    await downloadAndVerify(asset, destination, () => undefined, { fetch: async (_url, init) => {
      range = new Headers(init?.headers).get("range") ?? "";
      return {
        ok: true, status: 206, url: "https://release-assets.githubusercontent.com/update",
        headers: new Headers({ "content-length": String(complete.length - partial.length), "content-range": `bytes ${partial.length}-${complete.length - 1}/${complete.length}` }),
        body: new ReadableStream({ start(controller) { controller.enqueue(complete.subarray(partial.length)); controller.close(); } }),
      } as Response;
    } });
    assert.equal(range, `bytes=${partial.length}-`);
    assert.deepEqual(await readFile(destination), complete);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("aborts a stalled macOS update so the scheduler can retry", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "family-bridge-mac-update-stall-"));
  const destination = path.join(directory, "update.partial");
  const asset = {
    name: "Family-Bridge-9.9.9-arm64.zip",
    browser_download_url: "https://github.com/Dobrygnom/family-bridge/releases/download/v9.9.9/Family-Bridge-9.9.9-arm64.zip",
    digest: `sha256:${"a".repeat(64)}`,
    size: 100,
  };
  try {
    await assert.rejects(downloadAndVerify(asset, destination, () => undefined, { idleTimeoutMs: 10, fetch: async (_url, init) => {
      const signal = init?.signal;
      return {
        ok: true, status: 200, url: "https://release-assets.githubusercontent.com/update", headers: new Headers({ "content-length": "100" }),
        body: new ReadableStream({ start(controller) { signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true }); } }),
      } as Response;
    } }), /продолжена автоматически/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("reuses a completely downloaded verified macOS archive without another request", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "family-bridge-mac-update-complete-"));
  const destination = path.join(directory, "update.partial");
  const complete = Buffer.from("already downloaded update archive");
  await writeFile(destination, complete);
  let requested = false;
  try {
    await downloadAndVerify({
      name: "Family-Bridge-9.9.9-arm64.zip",
      browser_download_url: "https://github.com/Dobrygnom/family-bridge/releases/download/v9.9.9/Family-Bridge-9.9.9-arm64.zip",
      digest: `sha256:${createHash("sha256").update(complete).digest("hex")}`,
      size: complete.length,
    }, destination, () => undefined, { fetch: async () => { requested = true; throw new Error("unexpected request"); } });
    assert.equal(requested, false);
    assert.deepEqual(await readFile(destination), complete);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
