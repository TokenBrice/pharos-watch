import { DAY_SECONDS } from "@shared/lib/time-constants";
import { bucketUnixSecondsToUtcDay } from "@shared/lib/time-buckets";
import { getCirculatingRawOrNull, projectUsdMarketCapBaselineBuckets } from "@shared/lib/supply";
import type { StablecoinData } from "@shared/types/supply";
import { loadStablecoinsCache } from "../../lib/stablecoins-cache";
import { buildNativeSupplyBuckets, getLatestDetailTokenDate, type DetailResponseHelpers } from "./shared";

function buildCacheFallbackToken(
  date: number,
  circulatingUsd: Record<string, number> | undefined,
  pegType: string,
  price: number | null | undefined,
  native?: number | null,
): Record<string, unknown> | null {
  // The cache already stores provider-native USD circulating buckets. Wrapping
  // them for the canonical accessor preserves that contract without applying
  // any price conversion.
  const supplyUsd = getCirculatingRawOrNull({ circulating: circulatingUsd });
  if (supplyUsd == null) return null;
  return {
    date,
    totalCirculatingUSD: circulatingUsd,
    totalCirculating: native === undefined ? buildNativeSupplyBuckets(pegType, supplyUsd, price)
      : native === null ? {} : { [pegType]: native },
  };
}

export function buildCacheFallbackTokens(
  coin: StablecoinData,
  updatedAt: number,
  pegType: string,
): Record<string, unknown>[] {
  const currentDay = bucketUnixSecondsToUtcDay(updatedAt);
  const historicalToken = (window: "day" | "week" | "month", days: number, legacy: Record<string, number>) => {
    const baseline = coin.supplyChangeBaselines?.[window];
    const date = baseline ? bucketUnixSecondsToUtcDay(baseline.observedAt) : currentDay - days * DAY_SECONDS;
    // A non-USD bucket is a historical dollar cap; today's price cannot recover its token count.
    return buildCacheFallbackToken(date, projectUsdMarketCapBaselineBuckets(coin, window, legacy), pegType,
      coin.price, pegType === "peggedUSD" ? baseline?.circulatingNative : baseline?.circulatingNative ?? null);
  };
  return [
    historicalToken("month", 30, coin.circulatingPrevMonth),
    historicalToken("week", 7, coin.circulatingPrevWeek),
    historicalToken("day", 1, coin.circulatingPrevDay),
    buildCacheFallbackToken(currentDay, coin.circulating, pegType, coin.price, coin.circulatingNative),
  ].filter((token): token is Record<string, unknown> => token !== null);
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

  const tokens = buildCacheFallbackTokens(coin, stablecoinsCache.updatedAt, config.pegType);
  if (tokens.length === 0) {
    return detail.staleCacheOrError(404, `Stablecoin ${config.stablecoinId} has no historical detail source yet`);
  }

  return detail.createFallbackResponseFromTokens(tokens, getLatestDetailTokenDate(tokens));
}
