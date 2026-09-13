import type { ContextAnalysis } from "../src/core/context-analysis.js";
import type { StoredState } from "./store.js";
import type { UiErrorSnapshot } from "./ui-error-diagnostics.js";

export interface ApplicationDiagnostics {
  schema: 1; at: string;
  identity: { owner: string; displayName: string; peerName?: string; peerVersion?: string; counterpartPersonId?: string };
  topics: Array<Record<string, unknown>>;
  topicLaunches: Array<Record<string, unknown>>;
  ownerQuestions: Array<Record<string, unknown>>;
  conversations: Array<Record<string, unknown>>;
  continuations: Array<Record<string, unknown>>;
  deliveries: Array<Record<string, unknown>>;
  quarantined: Array<Record<string, unknown>>;
  reports: Array<Record<string, unknown>>;
  uiErrors: UiErrorSnapshot;
  invariants: Array<{ name: string; ok: boolean; details?: string }>;
}

export function buildApplicationDiagnostics(state: StoredState, analysis: ContextAnalysis | undefined, reports: Array<Record<string, unknown>>, uiErrors: UiErrorSnapshot = { schema:1, totalShown:0, currentlyVisible:false, visibleCount:0, recent:[] }): ApplicationDiagnostics {
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
  const duplicateLaunches = [...topicNames].filter(title => topicLaunches.filter(job => job.topic === title && job.status !== "complete").length > 1);
  const cyclicParents = Object.keys(state.conversationParents).filter(id => {
    const seen = new Set<string>();
    for (let current: string | undefined = id; current; current = state.conversationParents[current]) {
      if (seen.has(current)) return true;
      seen.add(current);
    }
    return false;
  });
  return { schema:1, at:new Date().toISOString(), identity:{ owner:state.owner, displayName:state.displayName, peerName:state.remote?.peerName,
    peerVersion:state.remote?.peerVersion, counterpartPersonId:state.remote?.counterpartPersonId }, topics, topicLaunches, ownerQuestions,
    conversations, continuations, deliveries, quarantined, reports, uiErrors,
    invariants:[
      { name:"one-active-launch-per-topic", ok:duplicateLaunches.length===0, ...(duplicateLaunches.length ? {details:duplicateLaunches.join(" | ")} : {}) },
      { name:"conversation-parents-acyclic", ok:cyclicParents.length===0, ...(cyclicParents.length ? {details:cyclicParents.join(" | ")} : {}) },
      { name:"no-duplicate-delivery-id", ok:new Set([...Object.keys(state.incomingDeliveries),...Object.keys(state.quarantinedDeliveries)]).size === Object.keys(state.incomingDeliveries).length + Object.keys(state.quarantinedDeliveries).length },
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
