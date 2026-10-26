import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename } from "node:fs/promises";
import path from "node:path";
import { writeDurableFile, type StoredState } from "./store.js";
import { isAgentId } from "../src/core/types.js";

const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const idFromReport = async (file: string) => {
  try { return String(JSON.parse(await readFile(file, "utf8")).conversationId || ""); } catch { return ""; }
};

const PROFILE_FILES = [
  "psychologist-memory/context-source.json",
  "psychologist-memory/context-analysis.json",
  "psychologist-memory/learned-context.json",
  "psychologist-memory/style-samples.jsonl",
  "psychologist-memory/personal-profile.md",
  "psychologist-memory/intake.json",
] as const;
const PROFILE_FILE_SET = new Set<string>(PROFILE_FILES);
type CheckpointFile = { relative: string; sha256: string };
type CheckpointManifest = { schema: 1 | 2; createdAt: string; version: string; stateSha256: string; reports: Array<{ file: string; id: string; sha256: string }>; files?: CheckpointFile[] };
export interface UpdateCheckpointRecovery { checkpointRoot?: string; state: Partial<StoredState>; restoredFiles: string[] }
export interface UpdateCheckpointDiagnostics { available: boolean; createdAt?: string; sourceVersion?: string; reports?: number; files?: number; reconciled?: boolean }

export async function createUpdateCheckpoint(userData: string, state: StoredState, version: string) {
  const base = path.join(userData, "update-checkpoints");
  await mkdir(base, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const checkpointId = randomUUID();
  const temporary = path.join(base, `.pending-${checkpointId}`), destination = path.join(base, `${stamp}-${checkpointId.slice(0,8)}-before-${version}`);
  const reportsDir = path.join(temporary, "reports");
  await mkdir(reportsDir, { recursive: true });
  const stateText = JSON.stringify(state);
  await writeDurableFile(path.join(temporary, "state.json"), stateText);
  const reports: CheckpointManifest["reports"] = [];
  for (const source of state.reports) {
    const bytes = await readFile(source), file = path.basename(source), id = await idFromReport(source);
    if (!id) throw new Error("Update checkpoint contains an invalid report");
    await writeDurableFile(path.join(reportsDir, file), bytes);
    reports.push({ file, id, sha256:hash(bytes) });
  }
  const files: CheckpointFile[] = [];
  for (const relative of PROFILE_FILES) {
    let bytes: Buffer;
    try { bytes = await readFile(path.join(userData, relative)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    await writeDurableFile(path.join(temporary, "profile", relative), bytes);
    files.push({ relative, sha256:hash(bytes) });
  }
  const manifest: CheckpointManifest = { schema:2, createdAt:new Date().toISOString(), version, stateSha256:hash(stateText), reports, files };
  await writeDurableFile(path.join(temporary, "manifest.json"), JSON.stringify(manifest));
  if (hash(await readFile(path.join(temporary, "state.json"))) !== manifest.stateSha256) throw new Error("Update checkpoint verification failed");
  for (const report of reports) if (hash(await readFile(path.join(reportsDir, report.file))) !== report.sha256) throw new Error("Update report checkpoint verification failed");
  for (const file of files) if (hash(await readFile(path.join(temporary, "profile", file.relative))) !== file.sha256) throw new Error("Update profile checkpoint verification failed");
  await rename(temporary, destination);
  return destination;
}

async function reconciled(root: string) {
  try { await readFile(path.join(root, "reconciled.json")); return true; } catch { return false; }
}

export async function latestUpdateCheckpoint(userData: string) {
  const base = path.join(userData, "update-checkpoints");
  let entries: string[];
  try { entries = (await readdir(base, { withFileTypes:true })).filter(e=>e.isDirectory()&&!e.name.startsWith(".pending-")).map(e=>e.name).sort().reverse(); }
  catch { return undefined; }
  for (const entry of entries) {
    const root = path.join(base, entry);
    try {
      const manifest = JSON.parse(await readFile(path.join(root,"manifest.json"),"utf8")) as CheckpointManifest;
      const stateText = await readFile(path.join(root,"state.json"),"utf8");
      if (![1,2].includes(manifest.schema) || hash(stateText) !== manifest.stateSha256 || !Array.isArray(manifest.reports)) continue;
      if (!(await Promise.all(manifest.reports.map(async report => Boolean(report && typeof report.file === "string" && path.basename(report.file) === report.file
        && typeof report.id === "string" && typeof report.sha256 === "string" && hash(await readFile(path.join(root,"reports",report.file)))===report.sha256)))).every(Boolean)) continue;
      const files = manifest.files ?? [];
      if (!Array.isArray(files) || files.some(file => !file || !PROFILE_FILE_SET.has(file.relative) || typeof file.sha256 !== "string")) continue;
      if (!(await Promise.all(files.map(async file=>hash(await readFile(path.join(root,"profile",file.relative)))===file.sha256))).every(Boolean)) continue;
      const state = JSON.parse(stateText) as StoredState;
      if (!state || typeof state !== "object" || !isAgentId(state.owner)) continue;
      return { root, state, reports:manifest.reports, files };
    } catch { /* Try the previous complete checkpoint. */ }
  }
  return undefined;
}

async function usableProfileFile(file: string, relative: string) {
  try {
    const contents = await readFile(file, "utf8");
    if (relative.endsWith(".json")) JSON.parse(contents);
    return true;
  } catch { return false; }
}

const unionStrings = (before: string[], now: string[]) => [...new Set([...before, ...now])];
const unionById = <T extends { id: string }>(before: T[], now: T[]) => [...new Map([...before, ...now].map(item => [item.id, item])).values()];

export async function recoverMissingCheckpointData(userData: string, current: StoredState): Promise<UpdateCheckpointRecovery> {
  // Only the newest verified checkpoint represents the immediately preceding
  // update. Never walk backwards into an old unconsumed checkpoint after the
  // newest one was reconciled: that would resurrect intentionally deleted data.
  const checkpoint = await latestUpdateCheckpoint(userData);
  if (!checkpoint || await reconciled(checkpoint.root)) return { state:{}, restoredFiles:[] };
  const currentIds = new Set((await Promise.all(current.reports.map(idFromReport))).filter(Boolean));
  const restoredReports: string[] = [];
  await mkdir(path.join(userData,"reports"),{recursive:true});
  for (const report of checkpoint.reports) {
    if (currentIds.has(report.id)) continue;
    const target = path.join(userData,"reports",`checkpoint-${report.file}`);
    await writeDurableFile(target, await readFile(path.join(checkpoint.root,"reports",report.file)));
    restoredReports.push(target);
  }
  const restoredFiles: string[] = [];
  for (const file of checkpoint.files) {
    const target = path.join(userData, file.relative);
    if (await usableProfileFile(target, file.relative)) continue;
    await writeDurableFile(target, await readFile(path.join(checkpoint.root,"profile",file.relative)));
    restoredFiles.push(file.relative);
  }

  const old = checkpoint.state;
  const state: Partial<StoredState> = {};
  const changed = <K extends keyof StoredState>(key: K, value: StoredState[K]) => {
    if (JSON.stringify(current[key]) !== JSON.stringify(value)) state[key] = value;
  };
  const mergeRecord = <T>(before: Record<string,T>, now: Record<string,T>) => ({...before,...now});
  changed("reports", [...restoredReports, ...current.reports]);
  changed("pendingTopics", unionStrings(old.pendingTopics ?? [], current.pendingTopics));
  changed("inFlightTopics", unionStrings(old.inFlightTopics ?? [], current.inFlightTopics));
  changed("pairTopics", unionStrings(old.pairTopics ?? [], current.pairTopics));
  changed("activeTopics", unionStrings(old.activeTopics ?? [], current.activeTopics));
  changed("blockedTopics", unionStrings(old.blockedTopics ?? [], current.blockedTopics));
  changed("completedIncoming", unionStrings(old.completedIncoming ?? [], current.completedIncoming));
  changed("ignoredConversationIds", unionStrings(old.ignoredConversationIds ?? [], current.ignoredConversationIds));
  changed("pendingOwnerQuestions", unionById(old.pendingOwnerQuestions ?? [], current.pendingOwnerQuestions));
  changed("pendingManualReplies", unionById(old.pendingManualReplies ?? [], current.pendingManualReplies));
  changed("topicLaunches", mergeRecord(old.topicLaunches ?? {}, current.topicLaunches));
  changed("topicSources", mergeRecord(old.topicSources ?? {}, current.topicSources));
  changed("topicBriefs", mergeRecord(old.topicBriefs ?? {}, current.topicBriefs));
  changed("conversationTranscripts", mergeRecord(old.conversationTranscripts ?? {}, current.conversationTranscripts));
  changed("conversationInheritedCounts", mergeRecord(old.conversationInheritedCounts ?? {}, current.conversationInheritedCounts));
  changed("continuations", mergeRecord(old.continuations ?? {}, current.continuations));
  changed("conversationParents", mergeRecord(old.conversationParents ?? {}, current.conversationParents));
  changed("conversationModes", mergeRecord(old.conversationModes ?? {}, current.conversationModes));
  changed("incomingDeliveries", mergeRecord(old.incomingDeliveries ?? {}, current.incomingDeliveries));
  changed("quarantinedDeliveries", mergeRecord(old.quarantinedDeliveries ?? {}, current.quarantinedDeliveries));
  if (!current.conversationReading && old.conversationReading) changed("conversationReading", old.conversationReading);
  if (!current.peerConversationReading && old.peerConversationReading) changed("peerConversationReading", old.peerConversationReading);
  if (!current.remote && old.remote) {
    changed("owner", old.owner); changed("remote", old.remote);
    changed("displayName", old.displayName); changed("language", old.language);
    changed("identityConfigured", old.identityConfigured); changed("onboardingComplete", old.onboardingComplete);
    changed("conversationReplyMode", old.conversationReplyMode); changed("autoStart", old.autoStart);
    if (old.processingMode) changed("processingMode", old.processingMode);
    if (old.codexModel) changed("codexModel", old.codexModel);
    if (old.codexReasoningEffort) changed("codexReasoningEffort", old.codexReasoningEffort);
    if (old.preferredCounterpartPersonId) changed("preferredCounterpartPersonId", old.preferredCounterpartPersonId);
  }
  for (const key of ["topicSourceMigrationVersion", "conversationResetVersion", "conversationResetAt", "experienceResetVersion", "experienceResetAt", "roleRepairCutoffAt", "lastConversationAt"] as const) {
    if (current[key] === undefined && old[key] !== undefined) changed(key, old[key]);
  }
  return { checkpointRoot:checkpoint.root, state, restoredFiles };
}

export async function completeUpdateCheckpointRecovery(root: string, appVersion: string) {
  await writeDurableFile(path.join(root, "reconciled.json"), JSON.stringify({ schema:1, reconciledAt:new Date().toISOString(), appVersion }));
}

export async function updateCheckpointDiagnostics(userData: string): Promise<UpdateCheckpointDiagnostics> {
  const checkpoint = await latestUpdateCheckpoint(userData);
  if (!checkpoint) return { available:false };
  const manifest = JSON.parse(await readFile(path.join(checkpoint.root,"manifest.json"),"utf8")) as CheckpointManifest;
  return { available:true, createdAt:manifest.createdAt, sourceVersion:manifest.version, reports:checkpoint.reports.length, files:checkpoint.files.length, reconciled:await reconciled(checkpoint.root) };
}
