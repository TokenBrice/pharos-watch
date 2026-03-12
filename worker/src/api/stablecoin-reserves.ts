import { jsonFreshResponse, errorResponse } from "../lib/api-utils";
import { TRACKED_IDS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import type { StablecoinReservesResponse } from "@shared/types";
import { resolveReserveResult } from "../lib/live-reserves-store";

export async function handleStablecoinReserves(
  db: D1Database,
  stablecoinId: string,
): Promise<Response> {
  if (!TRACKED_IDS.has(stablecoinId)) {
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
    ...(resolved.sync ? { sync: resolved.sync } : {}),
  };

  return jsonFreshResponse(body, { cacheControl: "public, s-maxage=3600, max-age=300" });
}
