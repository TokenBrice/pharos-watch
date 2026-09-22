import type { StablecoinData } from "@shared/types/market";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { addFreshnessHeaders } from "../lib/api-freshness";
import { errorResponse, jsonResponse } from "../lib/api-response";
import { API_CACHE_PROFILES as CACHE_PROFILES } from "@shared/lib/api-cache-profiles";
import { loadStablecoinsCache } from "../lib/stablecoins-cache";
import {
  getCirculatingRaw,
  getPrevDayRawOrNull,
  getPrevMonthRawOrNull,
  getPrevWeekRawOrNull,
} from "@shared/lib/supply";

export const handleStablecoinSummary = async (
  db: D1Database,
  id: string,
): Promise<Response> => {
  const stablecoinsCache = await loadStablecoinsCache(db, { mode: "strict" });
  if (stablecoinsCache.kind !== "ok") {
    return errorResponse(503, "Cached stablecoins data is corrupt");
  }

  const coin = stablecoinsCache.payload.peggedAssets.find((item: StablecoinData) => item.id === id);
  if (!coin) {
    return errorResponse(404, `Stablecoin ${id} not found`);
  }

  const currentSupplyUsd = getCirculatingRaw(coin);
  const prevDaySupplyUsd = getPrevDayRawOrNull(coin);
  const prevWeekSupplyUsd = getPrevWeekRawOrNull(coin);
  const prevMonthSupplyUsd = getPrevMonthRawOrNull(coin);

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
    supplyObservedAt: coin.supplyObservedAt ?? null,
    supplyRestored: coin.supplyRestored === true,
    supplyByPegUsd: coin.circulating,
    supplyUsd: {
      current: currentSupplyUsd,
      prevDay: prevDaySupplyUsd,
      prevWeek: prevWeekSupplyUsd,
      prevMonth: prevMonthSupplyUsd,
      change1d: prevDaySupplyUsd == null ? null : currentSupplyUsd - prevDaySupplyUsd,
      change7d: prevWeekSupplyUsd == null ? null : currentSupplyUsd - prevWeekSupplyUsd,
      change30d: prevMonthSupplyUsd == null ? null : currentSupplyUsd - prevMonthSupplyUsd,
    },
    chainCount: coin.chains.length,
    updatedAt: stablecoinsCache.updatedAt,
  }, {
    headers: addFreshnessHeaders(
      { "Cache-Control": CACHE_PROFILES.producerBacked },
      stablecoinsCache.updatedAt,
      API_FRESHNESS_MAX_AGE_SEC.stablecoins,
    ),
  });
};
