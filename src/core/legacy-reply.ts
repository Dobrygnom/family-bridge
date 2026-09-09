import type { StoredState } from "../../electron/store.js";
import type { RemoteEnvelope } from "./supabase-transport.js";

export function isKnownLegacyReply(state: StoredState, envelope: RemoteEnvelope<any>, expected?: string) {
  const transcript = state.conversationTranscripts[envelope.conversation_id];
  return Boolean(expected && state.remote?.pairId === envelope.pair_id
    && state.remote.peerExperienceVersion === expected
    && !envelope.payload.experienceVersion && envelope.payload.kind === "dialogue"
    && envelope.sequence_number > 1 && envelope.sender_agent !== state.owner
    && transcript?.topic === envelope.payload.topic
    && !state.ignoredConversationIds.includes(envelope.conversation_id)
    && (!state.conversationResetAt || Date.parse(envelope.created_at) >= Date.parse(state.conversationResetAt)));
}

// Recover only the next reply after an exact, already saved outbound message.
// Never revive a completed conversation or replay a whole remote history.
export function droppedReply(state: StoredState, rows: RemoteEnvelope<any>[], expected?: string) {
  const ordered = [...rows].sort((a,b)=>a.sequence_number-b.sequence_number);
  const id = ordered[0]?.conversation_id;
  const last = state.conversationTranscripts[id]?.messages.at(-1);
  if (!last || last.from !== state.owner) return;
  const sent = ordered.filter(row=>row.sender_agent === last.from && row.payload.text === last.text).at(-1);
  if (!sent) return;
  return ordered.find(row=>row.sequence_number === sent.sequence_number+1 && row.status === "processed"
    && isKnownLegacyReply(state,row,expected)
    && !state.completedIncoming.includes(row.id) && !state.incomingDeliveries[row.id]);
}
