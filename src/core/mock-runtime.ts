import type { AgentId, AgentResponse, AgentRuntime } from "./types.js";

export class MockAgent implements AgentRuntime {
  private turn = 0;

  constructor(
    readonly id: AgentId,
    private readonly messages: AgentResponse[],
  ) {}

  async start(): Promise<AgentResponse> {
    return this.next();
  }

  async respond(): Promise<AgentResponse> {
    return this.next();
  }

  private next(): AgentResponse {
    const response = this.messages[Math.min(this.turn, this.messages.length - 1)];
    this.turn += 1;
    return structuredClone(response);
  }
}
