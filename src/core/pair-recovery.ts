import { createHash } from "node:crypto";
import type { AgentId } from "./types.js";

// The route is exchanged only inside the already encrypted per-pair support
// channel. It is never compiled into a release or decrypted from public data.
export interface PairRecovery {
  version: 1;
  logicalPairId: string;
  transportPairId: string;
  creatorAuthId: string;
  creatorAgent: AgentId;
  inviteSecret: string;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validatePairRecovery(value: unknown): PairRecovery {
  const r = value as PairRecovery;
  if (!r || r.version !== 1 || !uuid.test(r.logicalPairId) || !uuid.test(r.transportPairId)
    || !uuid.test(r.creatorAuthId) || r.logicalPairId === r.transportPairId
    || !["dima", "katya"].includes(r.creatorAgent) || typeof r.inviteSecret !== "string" || r.inviteSecret.length < 32) {
    throw new Error("Invalid pair recovery invitation");
  }
  return r;
}
export function recoveryConversationId(route: PairRecovery, conversationId: string): string {
  if (!uuid.test(conversationId)) throw new Error("Invalid conversation id");
  const h = createHash("sha256").update(`family-bridge-recovery-v1:${route.transportPairId}:${conversationId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
