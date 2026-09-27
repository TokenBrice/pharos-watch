import type { StablecoinData } from "@shared/types/market";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { isObservedPrice } from "@shared/lib/pricing-source-policy";
import { addFreshnessHeaders } from "../lib/api-freshness";
import { errorResponse, jsonResponse } from "../lib/api-response";
import { API_CACHE_PROFILES as CACHE_PROFILES } from "@shared/lib/api-cache-profiles";
import { loadStablecoinsCache } from "../lib/stablecoins-cache";
import {
  getCirculatingRawOrNull,
  getPrevDayRawOrNull,
  getPrevMonthRawOrNull,
  getPrevWeekRawOrNull,
} from "@shared/lib/supply";
import { isFiniteNumber } from "@shared/lib/type-guards";

function supplyDelta(current: number | null, previous: number | null): number | null {
  return current == null || previous == null ? null : current - previous;
}

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

  // A present coin whose current buckets are absent/empty/invalid has unavailable current
  // supply (null + reason), never a measured 0 that would fabricate a -100% delta.
  const currentSupplyUsd = getCirculatingRawOrNull(coin);
  const prevDaySupplyUsd = getPrevDayRawOrNull(coin);
  const prevWeekSupplyUsd = getPrevWeekRawOrNull(coin);
  const prevMonthSupplyUsd = getPrevMonthRawOrNull(coin);

  return jsonResponse({
    id: coin.id,
    name: coin.name,
    symbol: coin.symbol,
    pegType: coin.pegType,
    pegMechanism: coin.pegMechanism,
    priceUsd: isObservedPrice(coin) ? coin.price ?? null : null,
    priceSource: coin.priceSource,
    priceConfidence: isObservedPrice(coin) ? coin.priceConfidence ?? null : null,
    ...(!isObservedPrice(coin) && coin.priceObservedAtMode != null ? { priceObservedAtMode: coin.priceObservedAtMode } : {}),
    ...(coin.nominalPriceReference ? { nominalPriceReference: coin.nominalPriceReference } : {}),
    supplySource: coin.supplySource ?? null,
    supplyObservedAt: coin.supplyObservedAt ?? null,
    supplyRestored: coin.supplyRestored === true,
    // Only finite buckets are published; an absent record is an empty bucket map, and
    // `supplyUsd.currentUnavailableReason` states the absence explicitly.
    supplyByPegUsd: Object.fromEntries(
      Object.entries(coin.circulating ?? {}).filter((entry): entry is [string, number] => isFiniteNumber(entry[1])),
    ),
    supplyUsd: {
      current: currentSupplyUsd,
      currentUnavailableReason: currentSupplyUsd == null ? "supply-buckets-missing" : null,
      prevDay: prevDaySupplyUsd,
      prevWeek: prevWeekSupplyUsd,
      prevMonth: prevMonthSupplyUsd,
      change1d: supplyDelta(currentSupplyUsd, prevDaySupplyUsd),
      change7d: supplyDelta(currentSupplyUsd, prevWeekSupplyUsd),
      change30d: supplyDelta(currentSupplyUsd, prevMonthSupplyUsd),
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
