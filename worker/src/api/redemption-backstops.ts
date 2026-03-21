import { withErrorHandler, errorResponse, jsonFreshResponse } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
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
      maxAgeSec: 3600,
    });
  },
);
