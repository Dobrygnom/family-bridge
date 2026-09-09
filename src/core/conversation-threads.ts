import type { AppState } from "../global.js";
import { VERSION_PROBE_PREFIX } from "./peer-version.js";

type Report = AppState["reportSummaries"][number];
type Message = Report["messages"][number];
export interface ConversationStage {
  id: string;
  parentReportId?: string;
  topic: string;
  messages: Message[];
  newMessages: Message[];
  report?: Report;
  live: boolean;
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
  return [...groups].map(([id, members]) => {
    const stages: ConversationStage[] = [], seen = new Set<string>();
    const append = (node: ConversationStage) => {
      if (seen.has(node.id)) return;
      seen.add(node.id);
      const parent = node.parentReportId ? nodes.get(node.parentReportId) : undefined;
      if (parent) append(parent);
      // Remove only an exact inherited prefix. If histories disagree, keep the
      // unmatched messages rather than cutting by a guessed message count.
      let inherited = 0;
      while (parent && stages.some(stage => stage.id === parent.id) && inherited < parent.messages.length && inherited < node.messages.length
        && parent.messages[inherited].text === node.messages[inherited].text
        && parent.messages[inherited].local === node.messages[inherited].local) inherited++;
      stages.push({ ...node, newMessages: node.messages.slice(inherited) });
    };
    members.sort((a, b) => (a.report?.completedAt ?? "\uffff").localeCompare(b.report?.completedAt ?? "\uffff")).forEach(append);
    const latest = stages.filter(stage => stage.report).at(-1)?.report;
    return { id, topic: stages[0].topic, stages, latest, live: stages.some(stage => stage.live),
      updatedAt: latest?.completedAt ?? "", messageCount: stages.reduce((sum, stage) => sum + stage.newMessages.length, 0) };
  }).sort((a, b) => Number(b.live) - Number(a.live) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}
