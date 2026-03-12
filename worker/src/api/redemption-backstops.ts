import { withErrorHandler, errorResponse, jsonFreshResponse } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import { buildRedemptionBackstopsSnapshot } from "../lib/redemption-backstops-store";

export const handleRedemptionBackstops = withErrorHandler(
  "redemption-backstops",
  async (db: D1Database): Promise<Response> => {
    const snapshot = await buildRedemptionBackstopsSnapshot(db);
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
