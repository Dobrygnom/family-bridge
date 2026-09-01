import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

export async function exportReportFiles(reportPaths: string[], destination: string) {
  await mkdir(destination, { recursive: true });
  let latestExport: string | undefined;
  for (const report of reportPaths.filter((item) => existsSync(item))) {
    const exported = path.join(destination, path.basename(report));
    await copyFile(report, exported);
    latestExport ??= exported;
  }
  return latestExport;
}

export function windowsRevealInvocation(target: string, windowsDirectory = process.env.WINDIR || process.env.SystemRoot || "C:\\Windows") {
  return {
    command: path.win32.join(windowsDirectory, "explorer.exe"),
    args: [`/select,${target}`],
  };
}

export function revealInWindowsExplorer(target: string) {
  const invocation = windowsRevealInvocation(target);
  return new Promise<void>((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
