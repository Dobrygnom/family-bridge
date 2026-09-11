import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { supportLocatorFiles } from "../electron/support-control.js";

const [command = "status", ...args] = process.argv.slice(2);
const commands = { diagnostics: ["GET", "/local/diagnostics"], "local-update": ["POST", "/local/update"], status: ["GET", "/status"], snapshot: ["POST", "/peer/snapshot"], update: ["POST", "/peer/update"] } as const;
if (!(command in commands) || args.length > 1) throw new Error("Usage: node --import tsx scripts/family-bridge-support.ts status|diagnostics|local-update|snapshot|update [profile-directory]");
const profile = args[0] || (process.platform === "win32" ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "family-bridge")
  : process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support", "family-bridge") : path.join(os.homedir(), ".config", "family-bridge"));
let success = false;
for (const file of supportLocatorFiles(profile)) {
  let locator: { port: number; token: string };
  try { locator = JSON.parse(await readFile(file, "utf8")); } catch { continue; }
  if (!Number.isInteger(locator.port) || locator.port < 1 || locator.port > 65535 || !/^[a-f0-9]{64}$/.test(locator.token)) continue;
  // Authenticate the discovered process with a read before sending a command.
  const headers = { Authorization: `Bearer ${locator.token}` };
  try {
    const probeRoute = command === "diagnostics" || command === "local-update" ? "/local/diagnostics" : "/status";
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
    const response = await fetch(`http://127.0.0.1:${locator.port}${route}`, { method, headers, signal: AbortSignal.timeout(45_000) });
    console.log(JSON.stringify(await response.json(), null, 2));
    process.exitCode = response.ok ? 0 : 1; success = true;
  } catch { console.error("Response unknown. Inspect status before retrying the request."); process.exitCode = 1; success = true; }
  break;
}
if (!success) { console.error("No authenticated running Family Bridge support endpoint. Check that a support-enabled build is running in the native profile; cached files do not prove it is online."); process.exitCode = 1; }
