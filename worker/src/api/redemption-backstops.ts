import { errorResponse, jsonFreshResponse, jsonResponse } from "../lib/api-response";
import { API_CACHE_PROFILES as CACHE_PROFILES } from "@shared/lib/api-cache-profiles";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import {
  buildRedemptionBackstopsSnapshot,
  RedemptionBackstopSnapshotUnavailableError,
} from "../lib/redemption-backstops-store";
import type { RedemptionBackstopsResponse } from "@shared/types/redemption";
import { readCoinProjectionId } from "../lib/api-coin-projection";

export const handleRedemptionBackstops = async (db: D1Database, stablecoinId?: string): Promise<Response> => {
  let snapshot: RedemptionBackstopsResponse;
  try {
    snapshot = await buildRedemptionBackstopsSnapshot(db, stablecoinId);
  } catch (err) {
    if (err instanceof RedemptionBackstopSnapshotUnavailableError) {
      return stablecoinId
        ? jsonResponse({ error: "Redemption backstop snapshot unavailable", reason: "redemption-snapshot-unavailable" }, { status: 503, noStore: true })
        : errorResponse(503, "Redemption backstop snapshot unavailable");
    }
    throw err;
  }
  if (snapshot.updatedAt === 0) {
    return errorResponse(503, "Data not yet available");
  }
  return jsonFreshResponse(snapshot, {
    cacheControl: CACHE_PROFILES.standard,
    updatedAt: snapshot.updatedAt,
    maxAgeSec: API_FRESHNESS_MAX_AGE_SEC.redemptionBackstops,
  });
};

export async function handleRedemptionBackstopCoin(db: D1Database, url: URL): Promise<Response> {
  const id = readCoinProjectionId(url);
  return id instanceof Response ? id : handleRedemptionBackstops(db, id);
}
