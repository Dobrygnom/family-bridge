export type AgentId = "dima" | "katya";

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
