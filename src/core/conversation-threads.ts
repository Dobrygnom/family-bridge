import type { AppState } from "../global.js";
import { VERSION_PROBE_PREFIX } from "./peer-version.js";
import { stitchMessages } from "./stitch-messages.js";

type Report = AppState["reportSummaries"][number];
type Message = Report["messages"][number];
export interface ConversationStage {
  id: string;
  parentReportId?: string;
  restarted?: boolean;
  topic: string;
  messages: Message[];
  inheritedMessageCount?: number;
  newMessages: Message[];
  report?: Report;
  live: boolean;
  activity?: import("./conversation-updates.js").LiveConversation["activity"];
}

// A read-only projection. Group exclusively by explicit parent IDs, never title.
// Missing parents and cycles must not make messages disappear.
export function conversationThreads(state: Pick<AppState, "reportSummaries" | "liveConversations">) {
  const nodes = new Map<string, ConversationStage>();
  for (const live of state.liveConversations ?? []) {
    if (!live.topic.startsWith(VERSION_PROBE_PREFIX)) nodes.set(live.id, { ...live, newMessages: [], live: true });
  }
  for (const report of state.reportSummaries) {
    const previous = nodes.get(report.id)?.report;
    if (!report.topic.startsWith(VERSION_PROBE_PREFIX) && (!previous || report.completedAt > previous.completedAt))
      nodes.set(report.id, { ...report, newMessages: [], report, live: false });
  }
  const rootOf = (id: string) => {
    const chain: string[] = [];
    let current = id;
    while (true) {
      const cycle = chain.indexOf(current);
      if (cycle >= 0) return chain.slice(cycle).sort()[0];
      chain.push(current);
      const parent = nodes.get(current)?.parentReportId;
      if (!parent) return current;
      if (!nodes.has(parent)) return parent;
      current = parent;
    }
  };
  const groups = new Map<string, ConversationStage[]>();
  for (const node of nodes.values()) {
    const root = rootOf(node.id);
    groups.set(root, [...(groups.get(root) ?? []), node]);
  }
  const stitched = stitchMessages([...nodes.values()], (a,b)=>a.local === b.local && a.text === b.text);
  return [...groups].map(([id, members]) => {
    const stages: ConversationStage[] = [], seen = new Set<string>();
    const append = (node: ConversationStage) => {
      if (seen.has(node.id)) return;
      seen.add(node.id);
      const parent = node.parentReportId ? nodes.get(node.parentReportId) : undefined;
      if (parent) append(parent);
      // Shared reconstruction handles explicit context lengths and mixed legacy
      // snapshots without rewriting reports or globally deduplicating replies.
      stages.push({ ...node, newMessages: stitched.get(node.id)!.newMessages });
    };
    members.sort((a, b) => (a.report?.completedAt ?? "\uffff").localeCompare(b.report?.completedAt ?? "\uffff")).forEach(append);
    const restart = stages.filter(stage => stage.restarted).at(-1);
    const attemptOf = (stage: ConversationStage): string | undefined => {
      const visited = new Set<string>();
      let node: ConversationStage | undefined = stage;
      while (node && !visited.has(node.id)) {
        visited.add(node.id);
        if (node.restarted) return node.id;
        node = node.parentReportId ? nodes.get(node.parentReportId) : undefined;
      }
    };
    const currentStages = restart ? stages.filter(stage => attemptOf(stage) === restart.id) : stages;
    const archivedStages = stages.filter(stage => !currentStages.includes(stage));
    const latest = currentStages.filter(stage => stage.report).at(-1)?.report;
    return { id, topic: stages[0].topic, stages, currentStages, archivedStages, latest, live: currentStages.some(stage => stage.live),
      updatedAt: latest?.completedAt ?? "", messageCount: currentStages.reduce((sum, stage) => sum + stage.newMessages.length, 0) };
  }).sort((a, b) => Number(b.live) - Number(a.live) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}
