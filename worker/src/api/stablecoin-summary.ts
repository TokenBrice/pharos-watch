import type { StablecoinData } from "@shared/types";
import {
  addFreshnessHeaders,
  errorResponse,
  jsonResponse,
  withErrorHandler,
} from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import { loadStablecoinsCache } from "../lib/stablecoins-cache";
import { sumPegBuckets } from "@shared/lib/supply";

export const handleStablecoinSummary = withErrorHandler("stablecoin-summary", async (
  db: D1Database,
  id: string,
): Promise<Response> => {
  const stablecoinsCache = await loadStablecoinsCache(db, { mode: "strict", allowLegacyArray: false });
  if (stablecoinsCache.kind !== "ok") {
    return errorResponse(503, "Cached stablecoins data is corrupt");
  }

  const coin = stablecoinsCache.payload.peggedAssets.find((item: StablecoinData) => item.id === id);
  if (!coin) {
    return errorResponse(404, `Stablecoin ${id} not found`);
  }

  const currentSupplyUsd = sumPegBuckets(coin.circulating);
  const prevDaySupplyUsd = sumPegBuckets(coin.circulatingPrevDay);
  const prevWeekSupplyUsd = sumPegBuckets(coin.circulatingPrevWeek);
  const prevMonthSupplyUsd = sumPegBuckets(coin.circulatingPrevMonth);

  return jsonResponse({
    id: coin.id,
    name: coin.name,
    symbol: coin.symbol,
    pegType: coin.pegType,
    pegMechanism: coin.pegMechanism,
    priceUsd: coin.price ?? null,
    priceSource: coin.priceSource,
    priceConfidence: coin.priceConfidence ?? null,
    supplySource: coin.supplySource ?? null,
    supplyByPegUsd: coin.circulating,
    supplyUsd: {
      current: currentSupplyUsd,
      prevDay: prevDaySupplyUsd,
      prevWeek: prevWeekSupplyUsd,
      prevMonth: prevMonthSupplyUsd,
      change1d: currentSupplyUsd - prevDaySupplyUsd,
      change7d: currentSupplyUsd - prevWeekSupplyUsd,
      change30d: currentSupplyUsd - prevMonthSupplyUsd,
    },
    chainCount: coin.chains.length,
    updatedAt: stablecoinsCache.updatedAt,
  }, addFreshnessHeaders({
    "Cache-Control": CACHE_PROFILES.realtime,
  }, stablecoinsCache.updatedAt, 600));
});
