/** Error values cross JSON/IPC boundaries and are often plain objects. */
export function errorMessage(value: unknown, fallback = "Не удалось выполнить действие."): string {
  const seen = new Set<object>();
  function read(input: unknown, depth: number): string | undefined {
    if (typeof input === "string") {
      const text = input.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, "").trim();
      return text && !/^\[object [^\]]+\]$/.test(text) ? text : undefined;
    }
    if (!input || typeof input !== "object" || depth > 4 || seen.has(input)) return;
    seen.add(input);
    for (const key of ["message", "error_description", "error", "cause", "details"]) {
      try { const text = read((input as Record<string, unknown>)[key], depth + 1); if (text) return text; }
      catch { /* A broken getter must not break error rendering. */ }
    }
  }
  return read(value, 0) ?? fallback;
}
