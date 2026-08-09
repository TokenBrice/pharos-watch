import { respondWithFreshSnapshot } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import {
  buildRedemptionBackstopsSnapshot,
  RedemptionBackstopSnapshotUnavailableError,
} from "../lib/redemption-backstops-store";

export const handleRedemptionBackstops = (db: D1Database): Promise<Response> =>
    respondWithFreshSnapshot({
      load: () => buildRedemptionBackstopsSnapshot(db),
      cacheControl: CACHE_PROFILES.standard,
      maxAgeSec: API_FRESHNESS_MAX_AGE_SEC.redemptionBackstops,
      unavailableError: RedemptionBackstopSnapshotUnavailableError,
      unavailableMessage: "Redemption backstop snapshot unavailable",
    });
