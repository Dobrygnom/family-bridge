import { copyFile, chmod, cp, mkdir } from "node:fs/promises";
import { existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const targetDirectory = path.join(root, "build", "codex-runtime");
const executableName = process.platform === "win32" ? "codex.exe" : "codex";
const target = path.join(targetDirectory, executableName);

function windowsDesktopCodex() {
  const base = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin");
  if (!base) return undefined;
  const candidates = [path.join(base, "codex.exe")];
  try {
    for (const entry of readdirSync(base, { withFileTypes: true })) if (entry.isDirectory()) candidates.push(path.join(base, entry.name, "codex.exe"));
  } catch {}
  return candidates.filter(existsSync).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

function locate() {
  if (process.env.CODEX_CLI_PATH && existsSync(process.env.CODEX_CLI_PATH)) return process.env.CODEX_CLI_PATH;
  if (process.platform === "win32") {
    const desktop = windowsDesktopCodex();
    if (desktop) return desktop;
    try { return execFileSync("where.exe", ["codex.exe"], { encoding: "utf8" }).split(/\r?\n/).find(Boolean); } catch { return undefined; }
  }
  const candidates = process.platform === "darwin"
    ? ["/Applications/Codex.app/Contents/Resources/codex", path.join(os.homedir(), "Applications", "Codex.app", "Contents", "Resources", "codex"), "/opt/homebrew/bin/codex", "/usr/local/bin/codex"]
    : ["/usr/local/bin/codex", "/usr/bin/codex"];
  return candidates.find(existsSync);
}

const source = locate();
if (!source) {
  throw new Error("Codex CLI was not found. Install it with the official OpenAI standalone installer or set CODEX_CLI_PATH before packaging.");
}
await mkdir(targetDirectory, { recursive: true });
if (path.resolve(source) !== path.resolve(target)) await copyFile(source, target);
if (process.platform !== "win32") await chmod(target, 0o755);

// A clean computer must not depend on another Codex installation for sandbox
// and code-mode helpers. Copy the canonical siblings when available, plus the
// standalone package resource directories used by current OpenAI installers.
const sourceDirectory = path.dirname(source);
const helperNames = process.platform === "win32"
  ? ["codex-code-mode-host.exe", "codex-command-runner.exe", "codex-windows-sandbox-setup.exe", "rg.exe"]
  : ["codex-code-mode-host", "rg"];
for (const name of helperNames) {
  const candidate = path.join(sourceDirectory, name);
  if (existsSync(candidate)) {
    const destination = path.join(targetDirectory, name);
    if (path.resolve(candidate) !== path.resolve(destination)) await copyFile(candidate, destination);
    if (process.platform !== "win32") await chmod(destination, 0o755);
  }
}
for (const name of ["codex-resources", "codex-path"]) {
  const candidate = [path.join(sourceDirectory, name), path.join(path.dirname(sourceDirectory), name)].find(item => existsSync(item));
  if (candidate) await cp(candidate, path.join(targetDirectory, name), { recursive: true, force: true });
}
console.log(`Bundled self-contained Codex runtime: ${source} -> ${targetDirectory}`);
