/**
 * Opaque protocol-v1 participant tokens. Their serialized values are retained
 * only so existing pairs and archives remain readable; they are roles, never
 * participant names. All UI and prompts use the configured display names.
 */
export const PAIR_CREATOR_AGENT_ID = "dima" as const;
export const PAIR_JOINER_AGENT_ID = "katya" as const;
export const PAIR_AGENT_IDS = [PAIR_CREATOR_AGENT_ID, PAIR_JOINER_AGENT_ID] as const;
export type AgentId = typeof PAIR_AGENT_IDS[number];
export type PairRole = "creator" | "joiner";

export function isAgentId(value: unknown): value is AgentId {
  return value === PAIR_CREATOR_AGENT_ID || value === PAIR_JOINER_AGENT_ID;
}

export function agentIdForRole(role: PairRole): AgentId {
  return role === "creator" ? PAIR_CREATOR_AGENT_ID : PAIR_JOINER_AGENT_ID;
}

export function roleForAgentId(id: AgentId): PairRole {
  return id === PAIR_CREATOR_AGENT_ID ? "creator" : "joiner";
}

export function peerAgentId(id: AgentId): AgentId {
  return id === PAIR_CREATOR_AGENT_ID ? PAIR_JOINER_AGENT_ID : PAIR_CREATOR_AGENT_ID;
}

export type ConversationStatus =
  | "proposing"
  | "agenda_negotiation"
  | "active"
  | "synthesizing"
  | "completed"
  | "paused"
  | "unsafe";

export interface AgentResponse {
  message_to_peer: string;
  status: "continue" | "complete" | "paused" | "unsafe";
  owner_question: string;
  topics: string[];
  private_report: string;
  shared_summary: string;
  comparison_summary?: string;
}

export interface BridgeMessage {
  id: string;
  conversationId: string;
  sequence: number;
  from: AgentId;
  to: AgentId;
  kind: "handshake" | "agent_message" | "completion";
  payload: string;
  createdAt: string;
  status: "pending" | "claimed" | "processed" | "failed";
  idempotencyKey: string;
}

export interface ConversationReport {
  conversationId: string;
  status: ConversationStatus;
  turns: number;
  messages: BridgeMessage[];
  privateReports: Partial<Record<AgentId, string>>;
  sharedSummary: string;
  topics: string[];
  startedAt: string;
  completedAt: string;
}

export interface AgentRuntime {
  readonly id: AgentId;
  start(initialPrompt: string): Promise<AgentResponse>;
  respond(peerMessage: string, guidance?: string): Promise<AgentResponse>;
  respondToOwner?(ownerMessage: string): Promise<AgentResponse>;
  revise?(instruction: string): Promise<AgentResponse>;
}
