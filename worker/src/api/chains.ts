import { loadStablecoinsCache } from "../lib/stablecoins-cache";
import { loadReportCardCache } from "../lib/report-card-cache";
import { aggregateChains } from "@shared/lib/chain-aggregator";
import { derivePegRates } from "@shared/lib/peg-rates";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { addFreshnessHeaders, errorResponse, jsonResponse } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";

const CHAINS_FRESHNESS_MAX_AGE_SEC = 600;

export async function handleChains(db: D1Database): Promise<Response> {
  const stablecoinsResult = await loadStablecoinsCache(db, { mode: "strict", allowLegacyArray: false });
  if (stablecoinsResult.kind !== "ok") {
    return errorResponse(503, "Data not yet available");
  }

  const { peggedAssets, fxFallbackRates } = stablecoinsResult.payload;

  // Derive peg rates for non-USD peg stability calculation
  const { rates: pegRates } = derivePegRates(peggedAssets, TRACKED_META_BY_ID, fxFallbackRates);

  // Load safety scores from report card cache (one D1 read)
  const safetyScores: Record<string, number> = {};
  const reportCardResult = await loadReportCardCache(db);
  if (reportCardResult.kind === "ok") {
    for (const [id, entry] of Object.entries(reportCardResult.payload.scores)) {
      safetyScores[id] = entry.score;
    }
  }

  const response = aggregateChains({
    peggedAssets,
    safetyScores,
    pegRates,
  });

  // Use stablecoins cache updatedAt for freshness
  response.updatedAt = stablecoinsResult.updatedAt;

  const headers = addFreshnessHeaders(
    { "Cache-Control": CACHE_PROFILES.realtime },
    stablecoinsResult.updatedAt,
    CHAINS_FRESHNESS_MAX_AGE_SEC,
  );

  return jsonResponse(response, headers);
}
