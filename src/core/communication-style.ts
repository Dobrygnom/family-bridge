/** Style examples are not factual memory. Sample complete messages throughout
 * the archive instead of cutting a recent, potentially distressed, JSON tail. */
export function selectCommunicationExamples(jsonl: string, limit = 24): string {
  const seen = new Set<string>();
  const candidates = jsonl.split(/\r?\n/).flatMap(line => {
    try {
      const item = JSON.parse(line);
      if (typeof item.text !== "string") return [];
      // Embedded dialogue/code is not reliable evidence of the owner's voice.
      if (/```|(?:^|\n)\s*\[\d{1,4}[/.:-]\d/.test(item.text)) return [];
      const text = item.text.split(/\r?\n/).filter((l: string) => !/^\s*>/.test(l)).join("\n").trim();
      if (text.length < 35 || text.length > 1600 || seen.has(text)) return [];
      seen.add(text);
      return [text];
    } catch { return []; }
  });
  const count = Math.min(Math.max(0, Math.floor(limit)), candidates.length);
  if (!count) return "Примеры отсутствуют: используй спокойный, прямой и естественный тон.";
  const selected = Array.from({ length: count }, (_, i) => candidates[Math.floor((i + 0.5) * candidates.length / count)]);
  return selected.map(text => JSON.stringify({ text })).join("\n");
}
