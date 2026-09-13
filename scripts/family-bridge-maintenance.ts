import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { supportLocatorFiles } from "../electron/support-control.js";

const [target, operation, conversationId, indexOrProfile, optionalProfile] = process.argv.slice(2);
if (!(["local","peer"] as string[]).includes(target) || !(["delete","restart"] as string[]).includes(operation)
  || !/^[a-z0-9-]{8,80}$/i.test(conversationId || "")) throw new Error("Usage: family-bridge-maintenance.ts local|peer delete <conversation-id> [profile] | local|peer restart <conversation-id> <message-index> [profile]");
const messageIndex = operation === "restart" ? Number(indexOrProfile) : undefined;
if (operation === "restart" && (!Number.isInteger(messageIndex) || messageIndex! < 0 || messageIndex! >= 100)) throw new Error("Message index must be 0..99");
const profileArg = operation === "restart" ? optionalProfile : indexOrProfile;
const profile = profileArg || (process.platform === "win32" ? path.join(process.env.APPDATA || path.join(os.homedir(),"AppData","Roaming"),"family-bridge") : process.platform === "darwin" ? path.join(os.homedir(),"Library","Application Support","family-bridge") : path.join(os.homedir(),".config","family-bridge"));
let completed=false;
for (const file of supportLocatorFiles(profile)) {
  let locator:{port:number;token:string}; try { locator=JSON.parse(await readFile(file,"utf8")); } catch { continue; }
  if (!Number.isInteger(locator.port) || !/^[a-f0-9]{64}$/.test(locator.token)) continue;
  const headers={Authorization:`Bearer ${locator.token}`,"Content-Type":"application/json"};
  try {
    const probe=await fetch(`http://127.0.0.1:${locator.port}/local/diagnostics`,{headers,signal:AbortSignal.timeout(5000)});
    if (!probe.ok || (await probe.json())?.schema !== 1) continue;
    const operationId=randomUUID();
    const command=operation === "delete" ? {operationId,operation:"delete-conversation",conversationId}
      : {operationId,operation:"restart-from-message",conversationId,messageIndex};
    const response=await fetch(`http://127.0.0.1:${locator.port}/${target}/maintenance`,{method:"POST",headers,body:JSON.stringify(command),signal:AbortSignal.timeout(45000)});
    console.log(JSON.stringify(await response.json(),null,2)); process.exitCode=response.ok?0:1; completed=true; break;
  } catch { console.error("Response unknown. Inspect status before retrying with the same operation id from the audit log."); process.exitCode=1; completed=true; break; }
}
if (!completed) { console.error("No authenticated running Family Bridge maintenance endpoint."); process.exitCode=1; }
