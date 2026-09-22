import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const feed = (version: string, arch: "x64" | "arm64", date = "2026-09-21T00:00:00.000Z") => `version: ${version}
files:
  - url: Family-Bridge-${version}-${arch}.zip
    sha512: zip-${arch}
    size: 10
  - url: Family-Bridge-${version}-${arch}.dmg
    sha512: dmg-${arch}
    size: 20
path: Family-Bridge-${version}-${arch}.zip
sha512: zip-${arch}
releaseDate: '${date}'
`;

const run = (args: string[]) => new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
  const child = spawn(process.execPath, [path.resolve("scripts/merge-mac-update-feeds.mjs"), ...args],
    { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  child.once("error", reject);
  child.once("exit", code => resolve({ code, stderr }));
});

test("release feed contains both macOS architectures and keeps a compatible legacy path", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fb-mac-feed-"));
  const x64 = path.join(dir, "x64.yml"), arm64 = path.join(dir, "arm64.yml"), output = path.join(dir, "latest-mac.yml");
  try {
    await writeFile(x64, feed("2.1.3", "x64"));
    await writeFile(arm64, feed("2.1.3", "arm64"));
    const result = await run([x64, arm64, output]);
    assert.equal(result.code, 0, result.stderr);
    const merged = await readFile(output, "utf8");
    assert.match(merged, /Family-Bridge-2\.1\.3-x64\.zip/);
    assert.match(merged, /Family-Bridge-2\.1\.3-arm64\.zip/);
    assert.match(merged, /Family-Bridge-2\.1\.3-x64\.dmg/);
    assert.match(merged, /Family-Bridge-2\.1\.3-arm64\.dmg/);
    assert.match(merged, /^path: Family-Bridge-2\.1\.3-x64\.zip$/m);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("release feed rejects mismatched versions", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fb-mac-feed-bad-"));
  const x64 = path.join(dir, "x64.yml"), arm64 = path.join(dir, "arm64.yml"), output = path.join(dir, "latest-mac.yml");
  try {
    await writeFile(x64, feed("2.1.3", "x64"));
    await writeFile(arm64, feed("2.1.4", "arm64"));
    const result = await run([x64, arm64, output]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /versions differ/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
