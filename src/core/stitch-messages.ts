// Read-only reconstruction of mixed legacy reports (full snapshots and fragments).
// New reports carry an explicit inherited count. Old files are never rewritten.
export function stitchMessages<M>(nodes: Array<{ id: string; parentReportId?: string; restarted?: boolean; inheritedMessageCount?: number; messages: M[] }>, equal: (a: M, b: M) => boolean) {
  const byId = new Map(nodes.map(n => [n.id, n]));
  type Entry = { history: M[]; legacy: M[]; newMessages: M[] };
  const result = new Map<string, Entry>(), visiting = new Set<string>();
  const prefix = (a: M[], b: M[]) => { let i = 0; while(i < a.length && i < b.length && equal(a[i],b[i])) i++; return i; };
  const visit = (id: string): Entry => {
    if (result.has(id)) return result.get(id)!;
    const node = byId.get(id)!;
    if (visiting.has(id)) return { history: [], legacy: [], newMessages: [] };
    visiting.add(id);
    const parent = !node.restarted && node.parentReportId ? byId.get(node.parentReportId) : undefined;
    const prior = parent ? visit(parent.id) : { history: [], legacy: [], newMessages: [] };
    let inherited = 0;
    if (parent) {
      const candidates = [parent.messages, prior.history, prior.legacy];
      inherited = Math.max(...candidates.map(messages => prefix(messages, node.messages)));
      // Some legacy exports kept a shortened, ordered tail of prior context.
      // Require multiple exact messages ending at its final message; never
      // globally remove repeated phrases or a single new acknowledgement.
      for (const previous of candidates) {
        let cursor = 0, matched = 0, last = -1;
        for (const message of node.messages) {
          while (cursor < previous.length && !equal(previous[cursor],message)) cursor++;
          if (cursor === previous.length) break;
          last = cursor++; matched++;
        }
        if (matched >= 2 && last === previous.length - 1) inherited = Math.max(inherited, matched);
      }
    }
    if (parent && !node.restarted && Number.isInteger(node.inheritedMessageCount) && node.inheritedMessageCount! >= 0 && node.inheritedMessageCount! <= node.messages.length)
      inherited = node.inheritedMessageCount!;
    const newMessages = node.messages.slice(inherited);
    const value = { history: [...prior.history, ...newMessages], legacy: [...prior.legacy, ...node.messages.slice(parent ? prefix(parent.messages,node.messages) : 0)], newMessages };
    result.set(id,value); visiting.delete(id); return value;
  };
  nodes.forEach(n=>visit(n.id)); return result;
}
