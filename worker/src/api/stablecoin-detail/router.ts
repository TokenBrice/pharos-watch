import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { handleCommodityDetail } from "./commodity";
import { handleCoinGeckoOnlyDetail } from "./coingecko-only";
import { handleCacheBackedDetail } from "./cache-fallback";
import { handleDefiLlamaDetail } from "./defillama";
import type { DetailResponseHelpers } from "./shared";

export function routeStablecoinDetail(
  config: {
    db: D1Database;
    stablecoinId: string;
    pegType: string;
    coingeckoApiKey?: string | null;
  },
  detail: DetailResponseHelpers,
): Promise<Response> {
  const meta = TRACKED_META_BY_ID.get(config.stablecoinId);
  const geckoId = meta?.geckoId;
  const isCommodity =
    !!meta && (meta.flags.pegCurrency === "GOLD" || meta.flags.pegCurrency === "SILVER") && !!geckoId;

  if (isCommodity) {
    return handleCommodityDetail(
      {
        stablecoinId: config.stablecoinId,
        geckoId,
        protocolSlug: meta.protocolSlug ?? "",
        pegType: config.pegType,
        coingeckoApiKey: config.coingeckoApiKey,
      },
      detail,
    );
  }

  if (meta?.detailProvider === "coingecko" && geckoId) {
    return handleCoinGeckoOnlyDetail(
      {
        db: config.db,
        stablecoinId: config.stablecoinId,
        geckoId,
        pegType: config.pegType,
        coingeckoApiKey: config.coingeckoApiKey,
      },
      detail,
    );
  }

  if (meta?.detailProvider === "coingecko") {
    return handleCacheBackedDetail(
      {
        db: config.db,
        stablecoinId: config.stablecoinId,
        pegType: config.pegType,
      },
      detail,
    );
  }

  return handleDefiLlamaDetail(
    {
      db: config.db,
      stablecoinId: config.stablecoinId,
      llamaId: meta?.llamaId ?? config.stablecoinId,
      meta,
    },
    detail,
  );
}
