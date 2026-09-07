/** Local retrieval only. Preserve chronology and neighbouring messages for meaning. */
export function relevantContextExcerpts(jsonl: string, query: string, limit = 60_000): string {
  const messages = jsonl.split(/\r?\n/).flatMap((line) => {
    try { const value = JSON.parse(line); return typeof value.text === "string" ? [value.text] : []; }
    catch { return []; }
  });
  const words = (value: string) => value.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [];
  const terms = new Set(words(query).map((word) => word.slice(0, 6)));
  const ranked = messages.map((text, index) => ({ index, score: [...new Set(words(text).map((word) => word.slice(0, 6)))].filter((word) => terms.has(word)).length }))
    .filter((item) => item.score > 0).sort((a, b) => b.score - a.score || b.index - a.index).slice(0, 24);
  const selected = new Set<number>();
  for (const { index } of ranked) for (const neighbour of [index - 1, index, index + 1]) if (messages[neighbour]) selected.add(neighbour);
  for (let index = Math.max(0, messages.length - 4); index < messages.length; index++) selected.add(index);
  let remaining = limit;
  return [...selected].sort((a, b) => a - b).flatMap((index) => {
    if (remaining <= 0) return [];
    const text = `[${index + 1}] ${messages[index].slice(0, Math.min(4000, remaining))}`;
    remaining -= text.length;
    return [text];
  }).join("\n\n");
}
