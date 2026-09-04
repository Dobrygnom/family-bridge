import { randomUUID } from "node:crypto";
import type {
  AgentId,
  AgentResponse,
  AgentRuntime,
  ConversationReport,
  ConversationStatus,
} from "./types.js";
import { InMemoryTransport } from "./transport.js";
import { completionReadiness, conversationOpeningPrompt, MAX_REMOTE_MESSAGES, prematureCompletionInstruction, type TopicBrief } from "./conversation-quality.js";

export interface CoordinatorOptions {
  maxTurns?: number;
  onEvent?: (event: CoordinatorEvent) => void;
}

export type CoordinatorEvent =
  | { type: "status"; status: ConversationStatus }
  | { type: "message"; from: AgentId; to: AgentId; text: string; turn: number }
  | { type: "agent_started"; agent: AgentId; sessionId?: string }
  | { type: "error"; error: string };

export class ConversationCoordinator {
  private readonly maxTurns: number;
  private readonly onEvent: (event: CoordinatorEvent) => void;

  constructor(
    private readonly dima: AgentRuntime,
    private readonly katya: AgentRuntime,
    private readonly transport = new InMemoryTransport(),
    options: CoordinatorOptions = {},
  ) {
    this.maxTurns = options.maxTurns ?? MAX_REMOTE_MESSAGES;
    this.onEvent = options.onEvent ?? (() => undefined);
  }

  async run(topic: string, brief?: TopicBrief): Promise<ConversationReport> {
    const conversationId = randomUUID();
    const startedAt = new Date().toISOString();
    const reports: Partial<Record<AgentId, string>> = {};
    const topicSet = new Set([topic]);
    let sharedSummary = "";
    let status: ConversationStatus = "agenda_negotiation";
    let turns = 0;

    this.onEvent({ type: "status", status });
    const opening = await this.dima.start(conversationOpeningPrompt("Дима", topic, brief));
    this.capture("dima", opening, reports, topicSet, (value) => {
      sharedSummary = value || sharedSummary;
    });
    this.transport.push(
      conversationId,
      "dima",
      "katya",
      opening.message_to_peer,
      "handshake",
    );
    this.onEvent({
      type: "message",
      from: "dima",
      to: "katya",
      text: opening.message_to_peer,
      turn: ++turns,
    });

    status = "active";
    this.onEvent({ type: "status", status });
    let active: AgentRuntime = this.katya;

    while (turns < this.maxTurns) {
      const message = this.transport.claim(conversationId, active.id);
      if (!message) break;
      let response: AgentResponse;
      try {
        response =
          turns === 1 && active.id === "katya"
            ? await active.start(message.payload)
            : await active.respond(message.payload);
        if (response.status === "complete") {
          const assessment = completionReadiness({ sequence: turns + 1, message: response.message_to_peer, sharedSummary: response.shared_summary });
          if (!assessment.ready) {
            const revised = active.revise ? await active.revise(prematureCompletionInstruction(topic, assessment.reasons)) : response;
            response = revised.status === "complete"
              ? { ...revised, status: "continue", shared_summary: "", comparison_summary: "" }
              : revised;
          }
        }
        this.transport.acknowledge(message.id);
      } catch (error) {
        this.transport.release(message.id);
        this.onEvent({
          type: "error",
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      this.capture(active.id, response, reports, topicSet, (value) => {
        sharedSummary = value || sharedSummary;
      });
      const recipient: AgentId = active.id === "dima" ? "katya" : "dima";
      const kind = response.status === "complete" ? "completion" : "agent_message";
      this.transport.push(
        conversationId,
        active.id,
        recipient,
        response.message_to_peer,
        kind,
      );
      this.onEvent({
        type: "message",
        from: active.id,
        to: recipient,
        text: response.message_to_peer,
        turn: ++turns,
      });

      if (response.status === "unsafe") {
        status = "unsafe";
        break;
      }
      if (response.status === "paused") {
        status = "paused";
        break;
      }
      if (response.status === "complete") {
        status = "synthesizing";
        this.onEvent({ type: "status", status });
        break;
      }
      active = active.id === "dima" ? this.katya : this.dima;
    }

    if (status === "synthesizing") status = "completed";
    else if (status === "active") status = "paused";
    this.onEvent({ type: "status", status });

    return {
      conversationId,
      status,
      turns,
      messages: this.transport.snapshot(conversationId),
      privateReports: reports,
      sharedSummary,
      topics: [...topicSet],
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }

  private capture(
    owner: AgentId,
    response: AgentResponse,
    reports: Partial<Record<AgentId, string>>,
    topics: Set<string>,
    setSharedSummary: (value: string) => void,
  ): void {
    response.topics.forEach((topic) => topics.add(topic));
    if (response.private_report) reports[owner] = response.private_report;
    if (response.shared_summary) setSharedSummary(response.shared_summary);
  }
}
