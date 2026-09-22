import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

const [, , x64Path, arm64Path, outputPath] = process.argv;
assert.ok(x64Path && arm64Path && outputPath,
  "Usage: node scripts/merge-mac-update-feeds.mjs <x64.yml> <arm64.yml> <output.yml>");

const normalize = value => value.replaceAll("\r\n", "\n");
const x64 = normalize(await readFile(x64Path, "utf8"));
const arm64 = normalize(await readFile(arm64Path, "utf8"));

const field = (feed, name) => {
  const match = feed.match(new RegExp(`^${name}:\\s*(.+)$`, "m"));
  assert.ok(match, `Missing ${name} in macOS update feed`);
  return match[1].trim();
};
const fileBlock = (feed, architecture) => {
  const match = feed.match(/^files:\n([\s\S]*?)^path:/m);
  assert.ok(match, `Missing files in ${architecture} macOS update feed`);
  const block = match[1].trimEnd();
  const urls = [...block.matchAll(/^\s+- url:\s*(\S+)$/gm)].map(item => item[1]);
  assert.deepEqual(urls.map(url => url.includes(architecture)), urls.map(() => true),
    `${architecture} feed contains a file for another architecture`);
  assert.deepEqual(urls.map(url => url.split(".").at(-1)).sort(), ["dmg", "zip"],
    `${architecture} feed must contain one DMG and one ZIP`);
  return { block, urls };
};

const version = field(x64, "version");
assert.equal(field(arm64, "version"), version, "macOS update feed versions differ");
const x64Files = fileBlock(x64, "x64");
const arm64Files = fileBlock(arm64, "arm64");
const allUrls = [...x64Files.urls, ...arm64Files.urls];
assert.equal(new Set(allUrls).size, 4, "macOS update feed contains duplicate files");

const legacyTail = x64.match(/^path:[\s\S]*$/m);
assert.ok(legacyTail, "Missing legacy update fields in x64 macOS feed");
assert.ok(!Number.isNaN(Date.parse(field(x64, "releaseDate").replaceAll("'", ""))), "Invalid x64 release date");
assert.ok(!Number.isNaN(Date.parse(field(arm64, "releaseDate").replaceAll("'", ""))), "Invalid arm64 release date");

const merged = `version: ${version}\nfiles:\n${x64Files.block}\n${arm64Files.block}\n${legacyTail[0].trimEnd()}\n`;
await writeFile(outputPath, merged, "utf8");
console.log(`Merged macOS update feed ${version}: ${allUrls.join(", ")}`);
