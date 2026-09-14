import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { StoredState } from "./store.js";

const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const idFromReport = async (file: string) => {
  try { return String(JSON.parse(await readFile(file, "utf8")).conversationId || ""); } catch { return ""; }
};

export async function createUpdateCheckpoint(userData: string, state: StoredState, version: string) {
  const base = path.join(userData, "update-checkpoints");
  await mkdir(base, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const temporary = path.join(base, `.pending-${randomUUID()}`), destination = path.join(base, `${stamp}-before-${version}`);
  const reportsDir = path.join(temporary, "reports");
  await mkdir(reportsDir, { recursive: true });
  const stateText = JSON.stringify(state);
  await writeFile(path.join(temporary, "state.json"), stateText, { encoding:"utf8", mode:0o600 });
  const reports: Array<{ file:string; id:string; sha256:string }> = [];
  for (const source of state.reports) {
    const bytes = await readFile(source), file = path.basename(source), id = await idFromReport(source);
    if (!id) throw new Error("Update checkpoint contains an invalid report");
    await copyFile(source, path.join(reportsDir, file));
    reports.push({ file, id, sha256:hash(bytes) });
  }
  const manifest = { schema:1, createdAt:new Date().toISOString(), version, stateSha256:hash(stateText), reports };
  await writeFile(path.join(temporary, "manifest.json"), JSON.stringify(manifest), { encoding:"utf8", mode:0o600 });
  if (hash(await readFile(path.join(temporary, "state.json"))) !== manifest.stateSha256) throw new Error("Update checkpoint verification failed");
  for (const report of reports) if (hash(await readFile(path.join(reportsDir, report.file))) !== report.sha256) throw new Error("Update report checkpoint verification failed");
  await rename(temporary, destination);
  return destination;
}

export async function latestUpdateCheckpoint(userData: string) {
  const base = path.join(userData, "update-checkpoints");
  let entries: string[];
  try { entries = (await readdir(base, { withFileTypes:true })).filter(e=>e.isDirectory()&&!e.name.startsWith(".pending-")).map(e=>e.name).sort().reverse(); }
  catch { return undefined; }
  for (const entry of entries) {
    const root = path.join(base, entry);
    try {
      const manifest = JSON.parse(await readFile(path.join(root,"manifest.json"),"utf8")) as {schema:number;stateSha256:string;reports:Array<{file:string;id:string;sha256:string}>};
      const stateText = await readFile(path.join(root,"state.json"),"utf8");
      if (manifest.schema !== 1 || hash(stateText) !== manifest.stateSha256) continue;
      if (!(await Promise.all(manifest.reports.map(async r=>hash(await readFile(path.join(root,"reports",r.file)))===r.sha256))).every(Boolean)) continue;
      return { root, state:JSON.parse(stateText) as StoredState, reports:manifest.reports };
    } catch { /* Try the previous complete checkpoint. */ }
  }
  return undefined;
}

export async function recoverMissingCheckpointData(userData: string, current: StoredState) {
  const checkpoint = await latestUpdateCheckpoint(userData);
  if (!checkpoint) return {};
  const currentIds = new Set((await Promise.all(current.reports.map(idFromReport))).filter(Boolean));
  const restored: string[] = [];
  await mkdir(path.join(userData,"reports"),{recursive:true});
  for (const report of checkpoint.reports) {
    if (currentIds.has(report.id)) continue;
    const target = path.join(userData,"reports",`checkpoint-${report.file}`);
    await copyFile(path.join(checkpoint.root,"reports",report.file),target); restored.push(target);
  }
  const old = checkpoint.state;
  const missing = <T>(before:Record<string,T>, now:Record<string,T>) => ({...before,...now});
  return {
    reports:[...restored,...current.reports],
    conversationTranscripts:missing(old.conversationTranscripts,current.conversationTranscripts),
    conversationParents:missing(old.conversationParents,current.conversationParents),
    conversationModes:missing(old.conversationModes,current.conversationModes),
    conversationInheritedCounts:missing(old.conversationInheritedCounts,current.conversationInheritedCounts),
    continuations:missing(old.continuations,current.continuations),
    pendingOwnerQuestions:[...old.pendingOwnerQuestions.filter(q=>!current.pendingOwnerQuestions.some(n=>n.id===q.id)),...current.pendingOwnerQuestions],
  };
}
