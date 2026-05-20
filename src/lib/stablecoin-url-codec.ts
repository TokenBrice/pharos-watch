import { CLIENT_TRACKED_IDS } from "@shared/lib/stablecoins/client-registry";

export function encodeStablecoinUrlToken(canonicalId: string): string {
  return canonicalId;
}

export function decodeStablecoinUrlToken(token: string | null | undefined): string | null {
  const trimmed = token?.trim();
  if (!trimmed) return null;

  return CLIENT_TRACKED_IDS.has(trimmed) ? trimmed : null;
}
