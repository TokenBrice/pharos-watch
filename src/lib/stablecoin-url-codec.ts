import { REGISTRY_BY_ID } from "@shared/lib/stablecoin-id-registry";

export function encodeStablecoinUrlToken(canonicalId: string): string {
  return canonicalId;
}

export function decodeStablecoinUrlToken(token: string | null | undefined): string | null {
  const trimmed = token?.trim();
  if (!trimmed) return null;

  return REGISTRY_BY_ID.has(trimmed) ? trimmed : null;
}
