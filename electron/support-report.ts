import { updateOperations, updateIpcChannels } from "./update-activity.js";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { Diagnostics } from "./diagnostics.js";

// This is a separate, stricter boundary than the LOCAL lifecycle log. Never
// serialize local paths, arbitrary exception text or crash dumps. Conversation
// identifiers are allowed only in the dedicated technical continuation schema.
const events = new Set([
  "startup.begin", "startup.ready", "startup.saved-state", "startup.failed", "process.runtime", "storage.file",
  "crash-capture.started", "crash-capture.failed", "process.previous-unfinished", "process.marker-write-failed",
  "process.before-quit", "process.will-quit", "process.quit", "process.child-gone", "process.uncaught-exception", "process.exit",
  "renderer.loaded", "renderer.preload-failed", "renderer.gone", "renderer.unresponsive", "renderer.responsive",
  "context.read-ready", "context.read-progress", "context.read-failed", "analysis.start", "analysis.progress", "analysis.coverage-invalid", "analysis.ready", "analysis.failed", "health.failed",
  "updater.gate", "updater.blocker", "updater.ipc", "updater.state", "connection.recovery-route-enabled", "connection.poll-failed", "connection.poll-ready",
  "dialogue.received", "dialogue.retry_pending", "dialogue.incompatible-version", "conversation.repair-deferred",
  "continuation.start", "continuation.sent", "continuation.failed", "continuation.resume-deferred", "automatic.retry-pending",
  "conversation.repair-started", "conversation.repair-identifiers-migrated",
  "peer-version.sent", "peer-version.received", "peer-version.timeout", "peer-version.error",
  "support.request", "support.received", "support.failed", "support.update-requested", "support.channel-failed", "support.channel-ready",
  "analysis.coverage-recovery", "topic.refinement.start", "topic.refinement.ready", "topic.refinement.failed",
]);
const codes = new Set(["COVERAGE_STRUCTURE", "COVERAGE_CANDIDATES", "COVERAGE_DUPLICATE_TOPIC", "COVERAGE_TOPIC_CONTENT", "COVERAGE_NO_EVIDENCE", "COVERAGE_NO_REASON", "COVERAGE_UNKNOWN_TOPIC", "COVERAGE_SPLIT_TOPIC", "COVERAGE_RECIPIENT_CHANGED", "CODEX_DESKTOP_UNAVAILABLE", "CODEX_DESKTOP_BUSY", "CODEX_DESKTOP_TIMEOUT", "CODEX_DESKTOP_PROTOCOL", "CODEX_HISTORY_READ_FAILED", "CHATGPT_SOURCE_UNAVAILABLE","CODEX_PROCESS_EXIT", "CODEX_ISOLATION_UNSUPPORTED", "TOPIC_COVERAGE_INVALID","ENOENT", "EACCES", "EPERM", "EBUSY", "ENOSPC", "ENOBUFS", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "PGRST301", "PGRST303", "INVALID_JSON", "AUTH", "PAIR_ACCESS", "NETWORK", "UNKNOWN"]);
export function supportErrorCode(error: unknown): string {
  const e = error as { code?: unknown; message?: unknown; cause?: { code?: unknown } } | null;
  for (const code of [e?.code, e?.cause?.code]) if (typeof code === "string" && codes.has(code)) return code;
  const message = typeof e?.message === "string" ? e.message : "";
  if (/авторизац|auth|refresh.*token|jwt/i.test(message)) return "AUTH";
  if (/saved pair|сохранённой паре|pair.*access/i.test(message)) return "PAIR_ACCESS";
  if (/fetch|network|сети|connect/i.test(message)) return "NETWORK";
  return "UNKNOWN";
}

type Fields = Record<string, string | number | boolean>;
const numeric = new Set(["exitCode","startedAt","people", "topics", "reports", "current", "total", "elapsedMs", "size", "uptimeSeconds", "workers", "pendingDeliveries", "continuations", "pendingQuestions", "pendingTopics", "progress", "healthAgeSeconds"]);
const booleans = new Set(["onboarding", "sourceReady", "ready", "available", "checking", "downloading", "installing", "installRequested", "updatedLaunch", "agentLaunched", "running", "contextSyncing", "portraitsUpdating", "configured", "connected", "codexChecked", "codexInstalled", "codexAuthenticated", "error", "recoveryRoute"]);
const enums: Record<string, readonly string[]> = {
  analysisCode: [...codes],
  operation: updateOperations, channel: updateIpcChannels,
  platform: ["win32", "darwin", "linux"], arch: ["x64", "arm64", "ia32"],
  analysisStatus: ["ready", "analyzing", "error", "other", "none"],
  fileKind: ["state", "source", "analysis"], waitingFor: ["activity", "dictation", "editing", "background"],
  stage: ["selection", "grouping", "idle", "preparing", "background", "activity", "installing", "retry", "complete","extract", "select", "merge", "coverage", "before-start", "after-start", "renderer-snapshot", "support", "update", "application", "uncaughtException", "unhandledRejection", "GPU", "Utility"],
};
export function sanitizeSupportFields(value: unknown): Fields {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Fields = {};
  for (const [key, v] of Object.entries(value)) {
    if (numeric.has(key) && typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER) result[key] = v;
    if (booleans.has(key) && typeof v === "boolean") result[key] = v;
    if (typeof v !== "string") continue;
    if (enums[key]?.includes(v) || key === "code" && codes.has(v)
      || ["version", "codexVersion"].includes(key) && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(v)
      || key === "sha256" && /^[a-f0-9]{64}$/.test(v)) result[key] = v;
  }
  return result;
}
export interface SupportReport {
  schema: 1; at: string; bootId: string; status: Fields; update: Fields;
  continuations?: Array<Fields>;
  updateDiagnostics?: ReturnType<typeof sanitizeUpdateDiagnostics>;
  dialogueDiagnostics?: ReturnType<typeof sanitizeDialogueDiagnostics>;
  events: Array<{ at: string; event: string; fields: Fields }>;
}
const iso = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v));
export const supportId = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
export function sanitizeDialogueDiagnostics(value: unknown) {
  const r = value as Record<string, any> | null;
  if (!r || typeof r !== "object") return undefined;
  const identifier = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
  const safe: Fields = {};
  if (["dima", "katya"].includes(r.owner)) safe.owner = r.owner;
  if (identifier(r.pairId)) safe.pairId = r.pairId;
  if (typeof r.peerVersion === "string" && /^\d+\.\d+\.\d+$/.test(r.peerVersion)) safe.peerVersion = r.peerVersion;
  if (typeof r.compatible === "boolean") safe.compatible = r.compatible;
  if (["checking", "received", "timeout", "error"].includes(r.probeStatus)) safe.probeStatus = r.probeStatus;
  for (const key of ["probeAgeMs", "received", "service", "dialogue", "staleService", "lastReceivedAt", "lastDialogueAt"])
    if (Number.isSafeInteger(r[key]) && r[key] >= 0) safe[key] = r[key];
  const repairs: Fields[] = (Array.isArray(r.repairs) ? r.repairs : []).slice(0,100).flatMap((row: any) => {
    if (!row || !identifier(row.id) || !identifier(row.requestId) || !["dima", "katya"].includes(row.initiator)
      || !["restarted", "peer", "starting", "waiting", "complete", "error", "active", "probe", "queued"].includes(row.reason)) return [];
    return [{ id: row.id, requestId: row.requestId, initiator: row.initiator, reason: row.reason }];
  });
  const conversations: Fields[] = (Array.isArray(r.conversations) ? r.conversations : []).slice(0,100).flatMap((row: any) => {
    if (!row || !identifier(row.id) || !Number.isSafeInteger(row.messages) || row.messages < 0) return [];
    const entry: Fields = { id: row.id, messages: row.messages };
    for (const key of ["lastFromLocal", "pending", "active"]) if (typeof row[key] === "boolean") entry[key] = row[key];
    return [entry];
  });
  return { ...safe, repairs, conversations };
}
function continuationDiagnostics(value: unknown): Fields[] {
  const identifier = (v: unknown): v is string => typeof v === "string" && /^(?:repair-1211-)?[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
  return (Array.isArray(value) ? value : []).slice(-100).flatMap(row => {
    if (!row || !identifier(row.id) || !identifier(row.parentId)) return [];
    const safe: Fields = { id: row.id, parentId: row.parentId };
    for (const key of ["prepared", "completed", "active", "ownerQuestion", "connectivityRetryUsed"]) if (typeof row[key] === "boolean") safe[key] = row[key];
    for (const key of ["attempts", "messages"]) if (Number.isSafeInteger(row[key]) && row[key] >= 0) safe[key] = row[key];
    for (const [key, values] of Object.entries({ mode: ["restart", "clean-continuation", "continuation"], status: ["starting", "waiting", "complete", "error"], failureKind: ["unsafe", "connection", "generation", "delivery"], failureCode: [...codes] })) {
      if (typeof row[key] === "string" && values.includes(row[key])) safe[key] = row[key];
    }
    return [safe];
  });
}
export function sanitizeUpdateDiagnostics(value: unknown) {
  const r = value as Record<string, any> | null;
  if (!r || typeof r !== "object") return undefined;
  const number = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  const gate: Fields = {};
  for (const key of ["pending", "checking"]) if (typeof r.gate?.[key] === "boolean") gate[key] = r.gate[key];
  for (const key of ["phaseStartedAt", "elapsedMs", "retryAfter"]) if (number(r.gate?.[key])) gate[key] = r.gate[key];
  if (["idle", "activity", "preparing", "background", "installing", "retry", "complete"].includes(r.gate?.phase)) gate.phase = r.gate.phase;
  const rows = (input: unknown, key: string, allowed: readonly string[]): Fields[] => (Array.isArray(input) ? input : []).slice(0, 80).flatMap(row => {
    if (!row || !allowed.includes(row[key]) || !number(row.startedAt) || !number(row.elapsedMs)) return [];
    return [{ [key]: row[key], startedAt: row.startedAt, elapsedMs: row.elapsedMs, ...(number(row.count) ? { count: row.count } : {}) }];
  });
  return { quiescing: r.quiescing === true, ...(number(r.drainStartedAt) ? { drainStartedAt: r.drainStartedAt } : {}),
    gate, blockers: rows(r.blockers, "operation", updateOperations), ipc: rows(r.ipc, "channel", updateIpcChannels),
    rendererBlocked: r.rendererBlocked === true,
    ...(["activity", "editing", "dictation"].includes(r.rendererReason) ? { rendererReason: r.rendererReason as string } : {}) };
}
export function sanitizeSupportReport(value: unknown): SupportReport | undefined {
  const r = value as SupportReport | null;
  if (!r || r.schema !== 1 || !iso(r.at) || !supportId(r.bootId)) return;
  return { schema: 1, at: r.at, bootId: r.bootId, status: sanitizeSupportFields(r.status), update: sanitizeSupportFields(r.update),
    ...(r.updateDiagnostics ? { updateDiagnostics: sanitizeUpdateDiagnostics(r.updateDiagnostics) } : {}),
    ...(r.dialogueDiagnostics ? { dialogueDiagnostics: sanitizeDialogueDiagnostics(r.dialogueDiagnostics) } : {}),
    ...(Array.isArray(r.continuations) ? { continuations: continuationDiagnostics(r.continuations) } : {}),
    events: (Array.isArray(r.events) ? r.events : []).slice(-120).filter(e => e && iso(e.at) && events.has(e.event))
      .map(e => ({ at: e.at, event: e.event, fields: sanitizeSupportFields(e.fields) })) };
}

function tail(file: string): unknown[] {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size, count = Math.min(size, 128_000);
    const buffer = Buffer.alloc(count);
    const bytes = readSync(fd, buffer, 0, count, size - count);
    const lines = buffer.subarray(0, bytes).toString("utf8").split("\n");
    if (size > count) lines.shift();
    return lines.slice(-500).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  } catch { return []; } finally { if (fd !== undefined) closeSync(fd); }
}
export function supportEvents(diagnostics: Diagnostics): SupportReport["events"] {
  const rows = [...tail(`${diagnostics.file}.previous`), ...tail(diagnostics.file), ...tail(diagnostics.fallbackFile)] as any[];
  const unique = new Map<string, SupportReport["events"][number]>();
  for (const row of rows) {
    if (!row || !iso(row.at) || !events.has(row.event)) continue;
    const entry = { at: row.at, event: row.event, fields: sanitizeSupportFields(row) };
    unique.set(JSON.stringify(entry), entry);
  }
  return [...unique.values()].sort((a,b) => a.at.localeCompare(b.at)).slice(-120);
}
