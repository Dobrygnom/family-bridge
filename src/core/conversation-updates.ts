import type { AppState } from "../global.js";

export interface LiveConversation {
  id: string;
  parentReportId?: string;
  topic: string;
  inheritedMessageCount: number;
  messages: Array<{ speaker: string; text: string; local: boolean }>;
}

export type ConversationSnapshot = Pick<AppState, "reports" | "reportSummaries" | "continuationStates"> & {
  conversationRevision: number;
  liveConversations: LiveConversation[];
};

export type ConversationUpdateEvent = { type: "conversations" } & ConversationSnapshot;

export function applyConversationUpdate(state: AppState, event: ConversationUpdateEvent): AppState {
  if (event.conversationRevision < (state.conversationRevision ?? 0)) return state;
  const { type: _type, ...update } = event;
  return { ...state, ...update };
}

// A focus/IPC snapshot started before a push must not roll back newer messages.
export function keepNewerConversations(current: AppState, incoming: AppState): AppState {
  if ((incoming.conversationRevision ?? 0) >= (current.conversationRevision ?? 0)) return incoming;
  return { ...incoming, conversationRevision: current.conversationRevision, liveConversations: current.liveConversations,
    reports: current.reports, reportSummaries: current.reportSummaries, continuationStates: current.continuationStates };
}

export function latestContinuation(state: AppState, reportId: string) {
  const live = state.liveConversations?.filter((conversation) => conversation.parentReportId === reportId).at(-1);
  if (live) return { id: live.id, complete: false, messages: live.messages.slice(live.inheritedMessageCount) };
  const report = state.reportSummaries.find((candidate) => candidate.parentReportId === reportId);
  if (!report) return undefined;
  const parent = state.reportSummaries.find((candidate) => candidate.id === reportId);
  return { id: report.id, complete: true, messages: report.messages.slice(parent?.messageCount ?? 0) };
}
