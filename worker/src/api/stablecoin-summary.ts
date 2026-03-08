import type { StablecoinData } from "@shared/types";
import {
  addFreshnessHeaders,
  errorResponse,
  jsonResponse,
  withErrorHandler,
} from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import { getCache } from "../lib/db";

interface StablecoinsCachePayload {
  peggedAssets: StablecoinData[];
}

function sumSupplyBuckets(buckets: Record<string, number> | null | undefined): number {
  if (!buckets) {
    return 0;
  }
  return Object.values(buckets).reduce((acc, value) => (Number.isFinite(value) ? acc + value : acc), 0);
}

export const handleStablecoinSummary = withErrorHandler("stablecoin-summary", async (
  db: D1Database,
  id: string,
): Promise<Response> => {
  const cached = await getCache(db, "stablecoins");
  if (!cached) {
    return errorResponse(503, "Data not yet available");
  }

  let parsed: StablecoinsCachePayload;
  try {
    parsed = JSON.parse(cached.value) as StablecoinsCachePayload;
  } catch {
    return errorResponse(503, "Cached stablecoins data is corrupt");
  }

  if (!parsed.peggedAssets || !Array.isArray(parsed.peggedAssets)) {
    return errorResponse(503, "Cached stablecoins data is corrupt");
  }

  const coin = parsed.peggedAssets.find((item) => item.id === id);
  if (!coin) {
    return errorResponse(404, `Stablecoin ${id} not found`);
  }

  const currentSupplyUsd = sumSupplyBuckets(coin.circulating);
  const prevDaySupplyUsd = sumSupplyBuckets(coin.circulatingPrevDay);
  const prevWeekSupplyUsd = sumSupplyBuckets(coin.circulatingPrevWeek);
  const prevMonthSupplyUsd = sumSupplyBuckets(coin.circulatingPrevMonth);

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
    updatedAt: cached.updatedAt,
  }, addFreshnessHeaders({
    "Cache-Control": CACHE_PROFILES.realtime,
  }, cached.updatedAt, 600));
});
