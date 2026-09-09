import { createHash } from "node:crypto";
import type { StoredState } from "./store.js";

// Stable across restarts, and compatible with bridge_messages.conversation_id UUID.
export function repairRequestId(rootId: string) {
  const hex = createHash("sha256").update(`family-bridge:repair-1211:${rootId}`).digest("hex").slice(0, 32).split("");
  hex[12] = "5"; hex[16] = ((parseInt(hex[16], 16) & 3) | 8).toString(16);
  const value = hex.join("");
  return `${value.slice(0,8)}-${value.slice(8,12)}-${value.slice(12,16)}-${value.slice(16,20)}-${value.slice(20)}`;
}

export function migrateRepairIdentifiers(state: StoredState): Partial<StoredState> {
  const continuations = { ...state.continuations }, transcripts = { ...state.conversationTranscripts };
  const parents = { ...state.conversationParents }, modes = { ...state.conversationModes };
  let changed = false;
  for (const [oldId, request] of Object.entries(state.continuations)) {
    const match = /^repair-1211-([a-f0-9-]{36})$/i.exec(oldId);
    if (!match || request.mode !== "restart" || !["error", "starting"].includes(request.status) || !request.preparedMessage) continue;
    // Only migrate unsent first replies. Never change an established dialogue.
    if ((transcripts[oldId]?.messages.length ?? 0) > request.history.length + 1
      || state.pendingOwnerQuestions.some(q => q.conversationId === oldId)) continue;
    const id = repairRequestId(match[1]);
    if (continuations[id]) continue;
    continuations[id] = { ...request, status: "starting", attempts: 0, retryAt: undefined };
    delete continuations[oldId];
    if (transcripts[oldId]) { transcripts[id] = transcripts[oldId]; delete transcripts[oldId]; }
    parents[id] = parents[oldId] ?? request.parentReportId; delete parents[oldId];
    modes[id] = "restart"; delete modes[oldId];
    changed = true;
  }
  return changed ? { continuations, conversationTranscripts: transcripts, conversationParents: parents, conversationModes: modes } : {};
}
