import { jsonFreshResponse, errorResponse } from "../lib/api-utils";
import { READABLE_IDS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { ReservePresentationMode, StablecoinReservesResponse } from "@shared/types/live-reserves";
import { resolveReserveResult } from "../lib/live-reserves-store";
import { CACHE_PROFILES } from "../lib/constants";

export function reserveCacheControlForMode(mode: ReservePresentationMode): string {
  if (mode === "live") return CACHE_PROFILES.reserveLive;
  if (mode === "live-stale") return CACHE_PROFILES.reserveLiveStale;
  return CACHE_PROFILES.reserveFallback;
}

export const handleStablecoinReserves = async (
  db: D1Database,
  stablecoinId: string,
): Promise<Response> => {
  if (!READABLE_IDS.has(stablecoinId)) {
    return errorResponse(404, "Not found");
  }

  const meta = TRACKED_META_BY_ID.get(stablecoinId);
  if (!meta?.liveReservesConfig) {
    return errorResponse(404, "Not found");
  }

  const resolved = await resolveReserveResult(db, stablecoinId);
  if (!resolved) {
    return errorResponse(404, "Not found");
  }

  const body: StablecoinReservesResponse = {
    stablecoinId,
    mode: resolved.mode,
    reserves: resolved.reserves,
    estimated: resolved.estimated,
    ...(resolved.liveAt != null ? { liveAt: resolved.liveAt } : {}),
    ...(resolved.source ? { source: resolved.source } : {}),
    ...(resolved.displayUrl ? { displayUrl: resolved.displayUrl } : {}),
    ...(resolved.evidenceUrls ? { evidenceUrls: resolved.evidenceUrls } : {}),
    ...(resolved.displayBadge ? { displayBadge: resolved.displayBadge } : {}),
    ...(resolved.metadata ? { metadata: resolved.metadata } : {}),
    ...(resolved.provenance ? { provenance: resolved.provenance } : {}),
    ...(resolved.sync ? { sync: resolved.sync } : {}),
  };

  return jsonFreshResponse(body, {
    cacheControl: reserveCacheControlForMode(resolved.mode),
  });
};
