import type { SharedMessage } from "./continuation.js";

export interface HistoryReport { id: string; parentReportId?: string; restarted?: boolean; cleanContext?: boolean; topic: string; completedAt: string; messages: SharedMessage[] }
export function resolveHistory(reports: HistoryReport[], requestedId: string) {
  const nodes = new Map(reports.map(report => [report.id, report]));
  if (!nodes.has(requestedId)) throw new Error("Исходный разговор не найден");
  const root = (id: string) => {
    const seen: string[] = [];
    while (nodes.get(id)?.parentReportId) {
      if (seen.includes(id)) throw new Error("Повреждена связь продолжений. История сохранена.");
      seen.push(id); id = nodes.get(id)!.parentReportId!;
    }
    return id;
  };
  const rootId = root(requestedId);
  const members = reports.filter(report => root(report.id) === rootId).sort((a,b) => a.completedAt.localeCompare(b.completedAt));
  const ordered: HistoryReport[] = [], visited = new Set<string>();
  const add = (r: HistoryReport) => {
    if (visited.has(r.id)) return;
    visited.add(r.id);
    const parent = r.parentReportId ? nodes.get(r.parentReportId) : undefined;
    if (parent) add(parent);
    ordered.push(r);
  };
  members.forEach(add);
  const restart = ordered.filter(report => report.restarted).at(-1);
  const attemptOf = (report: HistoryReport): string | undefined => {
    const seen = new Set<string>();
    let node: HistoryReport | undefined = report;
    while (node && !seen.has(node.id)) {
      seen.add(node.id);
      if (node.restarted) return node.id;
      node = node.parentReportId ? nodes.get(node.parentReportId) : undefined;
    }
  };
  const current = restart ? ordered.filter(report => attemptOf(report) === restart.id) : ordered;
  const history: SharedMessage[] = [];
  for (const report of current) {
    // A restart is an explicit context boundary, while its parent remains a UI link.
    if (report.restarted) history.length = 0;
    const parent = report.parentReportId ? nodes.get(report.parentReportId) : undefined;
    let prefix = 0;
    while (!report.restarted && parent && prefix < parent.messages.length && prefix < report.messages.length && parent.messages[prefix].from === report.messages[prefix].from && parent.messages[prefix].text === report.messages[prefix].text) prefix++;
    history.push(...report.messages.slice(prefix));
  }
  return { rootId, ids: new Set(ordered.map(report=>report.id)), latest: current.at(-1)!, history };
}
