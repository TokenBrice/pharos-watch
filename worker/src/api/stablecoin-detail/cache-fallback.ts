import { DAY_SECONDS } from "@shared/lib/time-constants";
import { sumPegBuckets } from "@shared/lib/supply";
import { loadStablecoinsCache } from "../../lib/stablecoins-cache";
import type { DetailResponseHelpers } from "./shared";

function buildCacheFallbackToken(
  date: number,
  circulatingUsd: Record<string, number> | undefined,
  pegType: string,
  price: number | null | undefined,
): Record<string, unknown> | null {
  const supplyUsd = sumPegBuckets(circulatingUsd);
  if (!Number.isFinite(supplyUsd) || supplyUsd <= 0) return null;
  return {
    date,
    totalCirculatingUSD: circulatingUsd,
    totalCirculating: {
      [pegType]: price && price > 0 ? supplyUsd / price : 0,
    },
  };
}

export async function handleCacheBackedDetail(
  config: {
    db: D1Database;
    stablecoinId: string;
    pegType: string;
  },
  detail: DetailResponseHelpers,
): Promise<Response> {
  const fallback = await detail.trySupplyHistoryFallback("coingecko-id-missing");
  if (fallback) return fallback;

  const stablecoinsCache = await loadStablecoinsCache(config.db, {
    mode: "strict",
  });
  if (stablecoinsCache.kind !== "ok") {
    return detail.staleCacheOrError(503, "Cached stablecoins data is unavailable");
  }

  const coin = stablecoinsCache.payload.peggedAssets.find((item) => item.id === config.stablecoinId);
  if (!coin) {
    return detail.staleCacheOrError(404, `Stablecoin ${config.stablecoinId} not found`);
  }

  const currentDay = Math.floor(stablecoinsCache.updatedAt / DAY_SECONDS) * DAY_SECONDS;
  const tokens = [
    buildCacheFallbackToken(currentDay - 30 * DAY_SECONDS, coin.circulatingPrevMonth, config.pegType, coin.price),
    buildCacheFallbackToken(currentDay - 7 * DAY_SECONDS, coin.circulatingPrevWeek, config.pegType, coin.price),
    buildCacheFallbackToken(currentDay - DAY_SECONDS, coin.circulatingPrevDay, config.pegType, coin.price),
    buildCacheFallbackToken(currentDay, coin.circulating, config.pegType, coin.price),
  ].filter((token): token is Record<string, unknown> => token !== null);

  if (tokens.length === 0) {
    return detail.staleCacheOrError(404, `Stablecoin ${config.stablecoinId} has no historical detail source yet`);
  }

  return detail.createFreshResponseFromTokens(tokens);
}
