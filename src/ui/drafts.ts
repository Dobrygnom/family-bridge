export const OWNER_DRAFTS_KEY = "family-bridge-owner-drafts-v1";
export function parseOwnerDrafts(raw: string | null): Record<string, string> {
  try {
    const value: unknown = JSON.parse(raw || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([key, text]) => key.length <= 200 && typeof text === "string" && text.length <= 100_000));
  } catch { return {}; }
}
