import { randomUUID } from "node:crypto";
import type { AgentId, BridgeMessage } from "./types.js";

export class InMemoryTransport {
  private readonly messages: BridgeMessage[] = [];
  private sequence = 0;

  push(
    conversationId: string,
    from: AgentId,
    to: AgentId,
    payload: string,
    kind: BridgeMessage["kind"] = "agent_message",
  ): BridgeMessage {
    const message: BridgeMessage = {
      id: randomUUID(),
      conversationId,
      sequence: ++this.sequence,
      from,
      to,
      kind,
      payload,
      createdAt: new Date().toISOString(),
      status: "pending",
      idempotencyKey: `${conversationId}:${this.sequence}:${from}:${to}`,
    };
    this.messages.push(message);
    return structuredClone(message);
  }

  claim(conversationId: string, recipient: AgentId): BridgeMessage | undefined {
    const message = this.messages.find(
      (item) =>
        item.conversationId === conversationId &&
        item.to === recipient &&
        item.status === "pending",
    );
    if (!message) return undefined;
    message.status = "claimed";
    return structuredClone(message);
  }

  acknowledge(messageId: string): void {
    const message = this.messages.find((item) => item.id === messageId);
    if (!message) throw new Error(`Unknown message: ${messageId}`);
    message.status = "processed";
  }

  release(messageId: string): void {
    const message = this.messages.find((item) => item.id === messageId);
    if (!message) throw new Error(`Unknown message: ${messageId}`);
    message.status = "pending";
  }

  snapshot(conversationId: string): BridgeMessage[] {
    return this.messages
      .filter((item) => item.conversationId === conversationId)
      .map((item) => structuredClone(item));
  }
}
