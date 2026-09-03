export interface PeerVersionCheck {
  status: "checking" | "received" | "timeout" | "error";
  requestedAt: string;
}

export const PEER_VERSION_TIMEOUT_MS = 20_000;
export const VERSION_PROBE_PREFIX = "family-bridge:version:";

export function validPeerVersion(value: unknown): string | undefined {
  return typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value.trim()) ? value.trim() : undefined;
}
