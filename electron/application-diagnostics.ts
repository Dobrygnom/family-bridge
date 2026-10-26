import type { ContextAnalysis } from "../src/core/context-analysis.js";
import type { StoredState, StoreRecoveryStatus } from "./store.js";
import type { UiErrorSnapshot } from "./ui-error-diagnostics.js";
import { readingReceiptSnapshot } from "../src/core/conversation-attention.js";
import { isAgentId } from "../src/core/types.js";
import type { UpdateCheckpointDiagnostics } from "./update-checkpoint.js";

export interface ApplicationDiagnostics {
  schema: 1; at: string;
  conversationReplyMode?: "automatic" | "manual";
  identity: { owner: string; displayName: string; peerName?: string; peerVersion?: string; counterpartPersonId?: string };
  topics: Array<Record<string, unknown>>;
  topicLaunches: Array<Record<string, unknown>>;
  ownerQuestions: Array<Record<string, unknown>>;
  manualReplies: Array<Record<string, unknown>>;
  conversations: Array<Record<string, unknown>>;
  continuations: Array<Record<string, unknown>>;
  deliveries: Array<Record<string, unknown>>;
  quarantined: Array<Record<string, unknown>>;
  reports: Array<Record<string, unknown>>;
  uiErrors: UiErrorSnapshot;
  reading?: { local?: ReturnType<typeof readingReceiptSnapshot>; peer?: StoredState["peerConversationReading"] };
  storage?: { recovery?: StoreRecoveryStatus; checkpoint?: UpdateCheckpointDiagnostics };
  invariants: Array<{ name: string; ok: boolean; details?: string }>;
}

export function buildApplicationDiagnostics(state: StoredState, analysis: ContextAnalysis | undefined, reports: Array<Record<string, unknown>>, uiErrors: UiErrorSnapshot = { schema:1, totalShown:0, currentlyVisible:false, visibleCount:0, recent:[] }, storageRecovery?: StoreRecoveryStatus, checkpoint?: UpdateCheckpointDiagnostics): ApplicationDiagnostics {
  const topicNames = new Set([...state.pendingTopics, ...state.inFlightTopics, ...state.pairTopics, ...state.activeTopics,
    ...Object.values(state.topicLaunches).map(job => job.topic), ...(analysis?.topics ?? []).map(topic => topic.title)]);
  const topics = [...topicNames].map(title => {
    const analyzed = analysis?.topics.find(topic => topic.title === title);
    const launches = Object.entries(state.topicLaunches).filter(([, job]) => job.topic === title).map(([id]) => id);
    return { title, pending: state.pendingTopics.includes(title), inFlight: state.inFlightTopics.includes(title), paired: state.pairTopics.includes(title),
      active: state.activeTopics.includes(title), blocked: state.blockedTopics.some(item => title.toLowerCase().includes(item.toLowerCase())),
      sources: state.topicSources[title] ?? [], brief: state.topicBriefs[title], launches,
      ...(analyzed ? { analysisId: analyzed.id, approved: analyzed.approved, dismissed: analyzed.dismissed, aboutPersonIds: analyzed.aboutPersonIds,
        discussWithPersonId: analyzed.discussWithPersonId, sensitivity: analyzed.sensitivity, reason: analyzed.reason } : {}) };
  });
  const topicLaunches = Object.entries(state.topicLaunches).map(([id, job]) => ({ id, ...job }));
  const conversations = Object.entries(state.conversationTranscripts).map(([id, transcript]) => ({ id, parentId: state.conversationParents[id],
    mode: state.conversationModes[id], inheritedMessageCount: state.conversationInheritedCounts[id], topic: transcript.topic, messages: transcript.messages }));
  const continuations = Object.entries(state.continuations).map(([id, continuation]) => ({ id, ...continuation }));
  const deliveries = Object.entries(state.incomingDeliveries).map(([id, delivery]) => ({ id, ...delivery }));
  const quarantined = Object.entries(state.quarantinedDeliveries).map(([id, delivery]) => ({ id, ...delivery }));
  const ownerQuestions = state.pendingOwnerQuestions.map(question => ({ ...question }));
  const manualReplies = state.pendingManualReplies.map(reply => ({ ...reply }));
  const duplicateLaunches = [...topicNames].filter(title => topicLaunches.filter(job => job.topic === title && job.status !== "complete").length > 1);
  const cyclicParents = Object.keys(state.conversationParents).filter(id => {
    const seen = new Set<string>();
    for (let current: string | undefined = id; current; current = state.conversationParents[current]) {
      if (seen.has(current)) return true;
      seen.add(current);
    }
    return false;
  });
  const invalidMessageRoles = [
    ...Object.entries(state.conversationTranscripts).filter(([, transcript]) => transcript.messages.some(message => !isAgentId(message.from))).map(([id]) => `conversation:${id}`),
    ...state.pendingOwnerQuestions.filter(question => question.transcript.some(message => !isAgentId(message.from))).map(question => `owner-question:${question.id}`),
    ...state.pendingManualReplies.filter(reply => reply.transcript.some(message => !isAgentId(message.from))).map(reply => `manual-reply:${reply.id}`),
    ...Object.entries(state.continuations).filter(([, continuation]) => continuation.history.some(message => !isAgentId(message.from))).map(([id]) => `continuation:${id}`),
  ].slice(0, 20);
  const reportIds = reports.flatMap(report => typeof report.id === "string" && report.id.trim() ? [report.id.trim()] : []);
  const duplicateReportIds = [...new Set(reportIds.filter((id, index) => reportIds.indexOf(id) !== index))].slice(0, 20);
  return { schema:1, at:new Date().toISOString(), conversationReplyMode:state.conversationReplyMode, identity:{ owner:state.owner, displayName:state.displayName, peerName:state.remote?.peerName,
    peerVersion:state.remote?.peerVersion, counterpartPersonId:state.remote?.counterpartPersonId }, topics, topicLaunches, ownerQuestions, manualReplies,
    conversations, continuations, deliveries, quarantined, reports, uiErrors,
    reading: { ...(readingReceiptSnapshot(state.conversationReading) ? { local: readingReceiptSnapshot(state.conversationReading) } : {}), ...(state.peerConversationReading ? { peer: state.peerConversationReading } : {}) },
    storage: { ...(storageRecovery ? { recovery: storageRecovery } : {}), ...(checkpoint ? { checkpoint } : {}) },
    invariants:[
      { name:"state-primary-recovered", ok:!storageRecovery || Boolean(storageRecovery.repairedAt), ...(storageRecovery && !storageRecovery.repairedAt ? {details:storageRecovery.reason} : {}) },
      { name:"one-active-launch-per-topic", ok:duplicateLaunches.length===0, ...(duplicateLaunches.length ? {details:duplicateLaunches.join(" | ")} : {}) },
      { name:"conversation-parents-acyclic", ok:cyclicParents.length===0, ...(cyclicParents.length ? {details:cyclicParents.join(" | ")} : {}) },
      { name:"no-duplicate-delivery-id", ok:new Set([...Object.keys(state.incomingDeliveries),...Object.keys(state.quarantinedDeliveries)]).size === Object.keys(state.incomingDeliveries).length + Object.keys(state.quarantinedDeliveries).length },
      { name:"unique-report-conversation-id", ok:duplicateReportIds.length===0, ...(duplicateReportIds.length ? {details:duplicateReportIds.join(" | ")} : {}) },
      { name:"conversation-message-roles-valid", ok:invalidMessageRoles.length===0, ...(invalidMessageRoles.length ? {details:invalidMessageRoles.join(" | ")} : {}) },
    ] };
}

/** Explicit diagnostics may contain application data, but never accept an unbounded peer payload. */
export function sanitizeApplicationDiagnostics(value: unknown): ApplicationDiagnostics | undefined {
  try {
    const json = JSON.stringify(value);
    if (!json || json.length > 4_000_000) return;
    const parsed = JSON.parse(json) as ApplicationDiagnostics;
    const forbidden = /^(encryptionsecret|invitesecret|sourcechat|sourcemessages|rawchat|sourceid|sourcehash|token|password|credential|filepath|path)$/i;
    const containsForbiddenKey = (item: unknown): boolean => Boolean(item && typeof item === "object" && Object.entries(item).some(([key, nested]) => forbidden.test(key) || containsForbiddenKey(nested)));
    if (containsForbiddenKey(parsed)) return;
    if (parsed?.schema !== 1 || typeof parsed.at !== "string" || !Array.isArray(parsed.topics) || !Array.isArray(parsed.invariants)) return;
    return parsed;
  } catch { return; }
}
