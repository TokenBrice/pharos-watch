import { errorResponse, jsonFreshResponse } from "../lib/api-response";
import { CACHE_PROFILES } from "../lib/constants";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import {
  buildRedemptionBackstopsSnapshot,
  RedemptionBackstopSnapshotUnavailableError,
} from "../lib/redemption-backstops-store";
import type { RedemptionBackstopsResponse } from "@shared/types/redemption";

export const handleRedemptionBackstops = async (db: D1Database): Promise<Response> => {
  let snapshot: RedemptionBackstopsResponse;
  try {
    snapshot = await buildRedemptionBackstopsSnapshot(db);
  } catch (err) {
    if (err instanceof RedemptionBackstopSnapshotUnavailableError) {
      return errorResponse(503, "Redemption backstop snapshot unavailable");
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
