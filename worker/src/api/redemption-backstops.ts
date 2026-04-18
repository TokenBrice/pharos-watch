import { withErrorHandler, errorResponse, jsonFreshResponse } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import {
  buildRedemptionBackstopsSnapshot,
  RedemptionBackstopSnapshotUnavailableError,
} from "../lib/redemption-backstops-store";

export const handleRedemptionBackstops = withErrorHandler(
  "redemption-backstops",
  async (db: D1Database): Promise<Response> => {
    let snapshot;
    try {
      snapshot = await buildRedemptionBackstopsSnapshot(db);
    } catch (error) {
      if (error instanceof RedemptionBackstopSnapshotUnavailableError) {
        return errorResponse(503, "Redemption backstop snapshot unavailable");
      }
      throw error;
    }
    if (snapshot.updatedAt === 0) {
      return errorResponse(503, "Data not yet available");
    }

    return jsonFreshResponse(snapshot, {
      cacheControl: CACHE_PROFILES.standard,
      updatedAt: snapshot.updatedAt,
      maxAgeSec: API_FRESHNESS_MAX_AGE_SEC.redemptionBackstops,
    });
  },
);
