import { resolveHistory, type HistoryReport } from "./conversation-history.js";

// Deliberately narrower than the generation guard: do not redo a conversation
// merely for a mentioned name, a quotation, or a disagreement between people.
export function hasExplicitRoleBreak(text: string) {
  return /(?:мы\s+(?:говорим|обсуждаем это|общаемся)\s+как\s+агент|я представляю перспективу|предложение двух агентов|согласие.{0,60}не стоит подменять нашим)/iu.test(text);
}

export function repairCandidates(reports: HistoryReport[], cutoffAt?: string) {
  const seen = new Set<string>();
  return reports.flatMap(report => {
    if (cutoffAt && (!Number.isFinite(Date.parse(report.completedAt)) || Date.parse(report.completedAt) > Date.parse(cutoffAt))) return [];
    if (!report.messages.some(message => hasExplicitRoleBreak(message.text))) return [];
    try {
      const thread = resolveHistory(reports, report.id);
      if (seen.has(thread.rootId)) return [];
      seen.add(thread.rootId);
      // One migration only. Later app versions must not keep resetting topics.
      if (reports.some(candidate => thread.ids.has(candidate.id) && candidate.restarted)) return [];
      const root = reports.find(candidate => candidate.id === thread.rootId);
      if (!root?.messages[0]) return [];
      return [{ rootId: thread.rootId, reportId: thread.latest.id, initiator: root.messages[0].from, ids: thread.ids }];
    } catch { return []; } // Preserve malformed histories for manual diagnosis.
  });
}
