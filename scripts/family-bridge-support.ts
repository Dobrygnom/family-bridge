import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { supportLocatorFiles } from "../electron/support-control.js";

const [command = "status", ...args] = process.argv.slice(2);
const commands = { "reply-mode": ["POST", "/local/reply-mode"], "refresh-context": ["POST", "/local/refresh-context"], diagnostics: ["GET", "/local/diagnostics"], "application-diagnostics": ["GET", "/local/application-diagnostics"], "read-status": ["GET", "/local/read-status"], "check-update": ["POST", "/local/check-update"], "force-update": ["POST", "/local/force-update"], "install-update": ["POST", "/local/update"], "local-update": ["POST", "/local/update"], status: ["GET", "/status"], snapshot: ["POST", "/peer/snapshot"], "peer-diagnostics": ["POST", "/peer/diagnostics"], update: ["POST", "/peer/update"], recover: ["POST", "/peer/recover"] } as const;
const replyMode = command === "reply-mode" ? args[0] : undefined;
const profileArg = command === "reply-mode" ? args[1] : args[0];
if (!(command in commands) || command === "reply-mode" && !["automatic", "manual"].includes(replyMode ?? "") || args.length > (command === "reply-mode" ? 2 : 1)) throw new Error("Usage: node --import tsx scripts/family-bridge-support.ts reply-mode automatic|manual [profile-directory] | status|diagnostics|application-diagnostics|read-status|check-update|force-update|install-update|refresh-context|snapshot|peer-diagnostics|update|recover [profile-directory]");
const profile = profileArg || (process.platform === "win32" ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "family-bridge")
  : process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support", "family-bridge") : path.join(os.homedir(), ".config", "family-bridge"));
let success = false;
for (const file of supportLocatorFiles(profile)) {
  let locator: { port: number; token: string };
  try { locator = JSON.parse(await readFile(file, "utf8")); } catch { continue; }
  if (!Number.isInteger(locator.port) || locator.port < 1 || locator.port > 65535 || !/^[a-f0-9]{64}$/.test(locator.token)) continue;
  // Authenticate the discovered process with a read before sending a command.
  const headers = { Authorization: `Bearer ${locator.token}` };
  try {
    const probeRoute = command === "diagnostics" || command === "application-diagnostics" || command === "read-status" || command === "check-update" || command === "force-update" || command === "install-update" || command === "local-update" || command === "refresh-context" || command === "reply-mode" ? "/local/diagnostics" : "/status";
    const probe = await fetch(`http://127.0.0.1:${locator.port}${probeRoute}`, { headers, signal: AbortSignal.timeout(5_000) });
    if (!probe.ok) continue;
    const local = await probe.json();
    const identity = probeRoute === "/status" ? local?.local : local;
    if (identity?.schema !== 1 || !identity.bootId) continue;
    if (command === "status" || command === "diagnostics") { console.log(JSON.stringify(local, null, 2)); success = true; break; }
  } catch { continue; }
  const [method, route] = commands[command as keyof typeof commands];
  // Never retry a mutation against another locator after an uncertain response.
  try {
    const response = await fetch(`http://127.0.0.1:${locator.port}${route}`, { method, headers, ...(command === "reply-mode" ? { body: JSON.stringify({ mode: replyMode }) } : {}), signal: AbortSignal.timeout(45_000) });
    console.log(JSON.stringify(await response.json(), null, 2));
    process.exitCode = response.ok ? 0 : 1; success = true;
  } catch { console.error("Response unknown. Inspect status before retrying the request."); process.exitCode = 1; success = true; }
  break;
}
if (!success) { console.error("No authenticated running Family Bridge support endpoint. Check that a support-enabled build is running in the native profile; cached files do not prove it is online."); process.exitCode = 1; }
