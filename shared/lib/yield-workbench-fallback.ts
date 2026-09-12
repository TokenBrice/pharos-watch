import { isCanonicalStablecoinId } from "./stablecoin-id";
import { hasStaticYieldWorkbench } from "./yield-auto-lending";
import type { StablecoinStatus } from "../types";

export const YIELD_WORKBENCH_FALLBACK_PARAM = "workbenchFallback";
export const MAX_YIELD_WORKBENCH_FALLBACK_ID_LENGTH = 64;

// This validates the transport boundary only. UI consumers must also resolve
// the result through the tracked registry before displaying coin metadata.
export function parseYieldWorkbenchFallbackId(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (id.length === 0 || id.length > MAX_YIELD_WORKBENCH_FALLBACK_ID_LENGTH) return null;
  return isCanonicalStablecoinId(id) ? id : null;
}

export interface YieldWorkbenchFallbackNotice {
  stablecoinId: string;
  symbol: string;
}

/**
 * Resolve the /yield leaderboard fallback notice for a `workbenchFallback` id.
 * Returns null when the id is untracked OR when the coin has a dedicated
 * workbench route in this release — the notice must not claim "not published
 * in this release" for coins that have one (E27).
 */
export function resolveYieldWorkbenchFallbackNotice(
  stablecoinId: string | null | undefined,
  metaById: ReadonlyMap<
    string,
    { id: string; symbol: string; status?: StablecoinStatus; flags: { yieldBearing?: boolean } }
  >,
): YieldWorkbenchFallbackNotice | null {
  if (!stablecoinId) return null;
  const meta = metaById.get(stablecoinId);
  if (!meta || hasStaticYieldWorkbench(meta)) return null;
  return { stablecoinId: meta.id, symbol: meta.symbol };
}

export function setYieldWorkbenchFallbackParam(searchParams: URLSearchParams, stablecoinId: string): boolean {
  const id = parseYieldWorkbenchFallbackId(stablecoinId);
  if (!id) return false;
  searchParams.set(YIELD_WORKBENCH_FALLBACK_PARAM, id);
  return true;
}
