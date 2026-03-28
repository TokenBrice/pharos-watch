import { getCache } from "../lib/db-cache";
import { withErrorHandler } from "../lib/api-utils";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { handleCommodityDetail } from "./stablecoin-detail/commodity";
import { handleCoinGeckoOnlyDetail } from "./stablecoin-detail/coingecko-only";
import { handleDefiLlamaDetail } from "./stablecoin-detail/defillama";
import {
  CACHE_TTL_SECONDS,
  createDetailResponseHelpers,
  createFreshCacheHitResponse,
} from "./stablecoin-detail/shared";

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

    const geckoId = meta?.geckoId;

    const isCommodity =
      !!meta && (meta.flags.pegCurrency === "GOLD" || meta.flags.pegCurrency === "SILVER") && !!geckoId;

    if (isCommodity) {
      return handleCommodityDetail(
        {
        stablecoinId: id,
        geckoId,
        protocolSlug: meta.protocolSlug ?? "",
        pegType,
        },
        detail,
      );
    }

    if (meta?.detailProvider === "coingecko" && geckoId) {
      return handleCoinGeckoOnlyDetail(
        {
          db,
          stablecoinId: id,
          geckoId,
          pegType,
          coingeckoApiKey,
        },
        detail,
      );
    }

    return handleDefiLlamaDetail(
      {
        db,
        stablecoinId: id,
        llamaId: meta?.llamaId ?? id,
        meta,
      },
      detail,
    );
  },
);
