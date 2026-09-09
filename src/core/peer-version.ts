export interface PeerVersionCheck {
  status: "checking" | "received" | "timeout" | "error";
  requestedAt: string;
}

export const PEER_VERSION_TIMEOUT_MS = 20_000;
export const VERSION_PROBE_PREFIX = "family-bridge:version:";
export const PEER_HEARTBEAT_MS = 60_000;
export const PEER_ONLINE_TTL_MS = 90_000;

export function peerIsOnline(confirmedAt: string | undefined, now = Date.now()): boolean {
  const timestamp = confirmedAt ? Date.parse(confirmedAt) : Number.NaN;
  return Number.isFinite(timestamp) && now >= timestamp && now - timestamp < PEER_ONLINE_TTL_MS;
}

export function supportsSilentVersionProbe(version: string | undefined): boolean {
  if (!validPeerVersion(version)) return false;
  const [major, minor, patch] = version!.split('.').map(Number);
  return major > 0 || minor > 3 || (minor === 3 && patch >= 31);
}

export function validPeerVersion(value: unknown): string | undefined {
  return typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value.trim()) ? value.trim() : undefined;
}
