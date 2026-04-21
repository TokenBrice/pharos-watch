import { getCache } from "../lib/db-cache";
import { withErrorHandler } from "../lib/api-utils";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import {
  CACHE_TTL_SECONDS,
  createDetailResponseHelpers,
  createFreshCacheHitResponse,
} from "./stablecoin-detail/shared";
import { routeStablecoinDetail } from "./stablecoin-detail/router";

export const handleStablecoinDetail = withErrorHandler(
  "stablecoin-detail",
  async (db: D1Database, id: string, ctx: ExecutionContext, coingeckoApiKey?: string | null): Promise<Response> => {
    const cacheKey = `detail:${id}`;
    const cached = await getCache(db, cacheKey);
    const meta = TRACKED_META_BY_ID.get(id);
    const pegType = `pegged${meta?.flags.pegCurrency ?? "USD"}`;

    if (cached) {
      const age = Math.floor(Date.now() / 1000) - cached.updatedAt;
      if (age < CACHE_TTL_SECONDS) {
        return createFreshCacheHitResponse(cached.value, age);
      }
    }

    const detail = createDetailResponseHelpers({
      db,
      stablecoinId: id,
      pegType,
      cached,
      execCtx: ctx,
    });
    return routeStablecoinDetail({ db, stablecoinId: id, pegType, coingeckoApiKey }, detail);
  },
);
