import type { TopicBrief } from "./conversation-quality.js";
import type { MessageOrigin, SharedMessage } from "./continuation.js";

export const DIALOGUE_PROTOCOL_VERSION = 2 as const;

export interface TopicPayload {
  protocol?: 1 | 2; kind: "topic"; topic: string; senderName?: string; senderVersion?: string; experienceVersion?: string;
  versionOnly?: boolean; requestUpdateCheck?: boolean; requestVersion?: boolean; brief?: TopicBrief; support?: unknown;
}
export interface DialoguePayload {
  protocol?: 1 | 2; brief?: TopicBrief; origin?: MessageOrigin; kind?: "dialogue"; text: string; topic: string; status: string;
  sharedSummary?: string; comparisonSummary?: string; senderName?: string; senderVersion?: string; experienceVersion?: string; sentAt?: string;
  continuation?: { parentReportId: string; history: SharedMessage[]; mode?: "restart" | "clean-continuation" };
}
export type BridgeWirePayload = TopicPayload | DialoguePayload;

const text = (value: unknown, limit: number, required = false) => value === undefined
  ? !required
  : typeof value === "string" && value.length <= limit && (!required || Boolean(value.trim()));

/** Structural validation at the encrypted transport boundary. Semantic checks stay in the owning service. */
export function bridgeWirePayload(value: unknown): BridgeWirePayload | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const payload = value as Record<string, unknown>;
  if (payload.protocol !== undefined && payload.protocol !== 1 && payload.protocol !== 2) return;
  if (!text(payload.topic, 2_000, true) || !text(payload.senderName, 500) || !text(payload.senderVersion, 50) || !text(payload.experienceVersion, 100)) return;
  if (payload.kind === "topic") {
    for (const flag of [payload.versionOnly, payload.requestUpdateCheck, payload.requestVersion]) if (flag !== undefined && typeof flag !== "boolean") return;
    return payload as unknown as TopicPayload;
  }
  if (payload.kind !== undefined && payload.kind !== "dialogue" || !text(payload.text, 30_000, true) || !text(payload.status, 50, true)
    || !text(payload.sharedSummary, 30_000) || !text(payload.comparisonSummary, 30_000) || !text(payload.sentAt, 100)) return;
  return payload as unknown as DialoguePayload;
}
