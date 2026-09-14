import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { AtomicStore, type OwnerId } from "../electron/store.js";
import { supportLocatorFiles } from "../electron/support-control.js";

const [reportId, profileArg] = process.argv.slice(2);
if (!/^[0-9a-f-]{36}$/i.test(reportId || "")) throw new Error("Usage: recover-peer-conversation.ts <report-id> [profile]");
const profile = profileArg || (process.platform === "win32"
  ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "family-bridge")
  : path.join(os.homedir(), "Library", "Application Support", "family-bridge"));
let status: any;
for (const file of supportLocatorFiles(profile)) {
  try {
    const locator = JSON.parse(await readFile(file, "utf8"));
    const response = await fetch(`http://127.0.0.1:${locator.port}/status`, { headers:{ Authorization:`Bearer ${locator.token}` }, signal:AbortSignal.timeout(5_000) });
    if (response.ok) { status = await response.json(); break; }
  } catch { /* Try the next live locator. */ }
}
if (!status) throw new Error("Authenticated local diagnostic endpoint is unavailable");
const received = Object.values(status.requests || {}).filter((item: any) => item?.status === "received" && item.report?.applicationDiagnostics)
  .sort((a: any, b: any) => String(b.requestedAt).localeCompare(String(a.requestedAt)));
const diagnostic = received.map((item: any) => item.report.applicationDiagnostics)
  .find((item: any) => item.reports?.some((report: any) => report.id === reportId));
const report = diagnostic?.reports?.find((item: any) => item.id === reportId);
if (!report || !Array.isArray(report.messages) || !report.parentReportId) throw new Error("Completed peer report was not found in the latest diagnostic response");
const peerOwner = diagnostic.identity?.owner as OwnerId;
if (peerOwner !== "dima" && peerOwner !== "katya") throw new Error("Peer identity is invalid");
const store = new AtomicStore(profile), state = await store.read();
if (state.owner === peerOwner) throw new Error("Peer diagnostic identity matches the local identity");
if (state.reports.some(file => file.includes(reportId))) { console.log(JSON.stringify({ status:"already-present", reportId })); process.exit(0); }
const reportsDir = path.join(profile, "reports");
await mkdir(reportsDir, { recursive: true });
const reportPath = path.join(reportsDir, `${String(report.completedAt).replace(/[:.]/g, "-")}-${reportId}-peer-recovered.json`);
const messages = report.messages.map((message: any) => ({
  from: message.local ? peerOwner : state.owner,
  text: String(message.text),
  ...(message.origin ? { origin: message.origin } : {}),
  ...(message.sentAt ? { sentAt: message.sentAt } : {}),
}));
await copyFile(path.join(profile, "state.json"), path.join(profile, `state.before-peer-recovery-${Date.now()}.json`));
await writeFile(reportPath, JSON.stringify({
  conversationId: report.id, parentReportId: report.parentReportId, restarted: true,
  inheritedMessageCount: Number.isInteger(report.inheritedMessageCount) ? report.inheritedMessageCount : 0,
  cleanContext: true, pairId: state.remote?.pairId, topic: report.topic,
  sharedSummary: report.summary, answerFrom: report.answerFrom, answerFromOwnerId: peerOwner,
  comparisonSummary: report.comparison, completionState: report.completionState || "completed",
  topicSources: state.topicSources[report.topic] ?? ["peer"], messages, completedAt: report.completedAt,
}, null, 2), "utf8");
const continuation = diagnostic.continuations?.find((item: any) => item.id === report.id);
await store.mutate(current => ({
  reports: [reportPath, ...current.reports],
  conversationParents: { ...current.conversationParents, [report.id]: report.parentReportId },
  conversationModes: { ...current.conversationModes, [report.id]: "restart" },
  conversationInheritedCounts: { ...current.conversationInheritedCounts, [report.id]: 0 },
  continuations: { ...current.continuations, [report.id]: {
    mode:"restart", originReportId:report.parentReportId, parentReportId:report.parentReportId,
    topic:report.topic, pairId:current.remote?.pairId || "", instruction:continuation?.instruction || "Обсудить исходную тему заново.",
    history:[], status:"complete", attempts:Number.isInteger(continuation?.attempts) ? continuation.attempts : 1,
    connectivityRetryUsed:Boolean(continuation?.connectivityRetryUsed), preparedMessage:continuation?.preparedMessage,
  } },
  lastConversationAt: report.completedAt,
}));
console.log(JSON.stringify({ status:"recovered", reportId, parentReportId:report.parentReportId, messages:messages.length, reportPath }));
