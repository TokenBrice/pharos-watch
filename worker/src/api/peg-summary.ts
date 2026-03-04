import { DEX_PRICE_CHECK_FRESHNESS_SEC } from "../lib/constants";
import { derivePegRates, getPegReference } from "../../../src/lib/peg-rates";
import { TRACKED_STABLECOINS } from "../../../src/lib/stablecoins";
import type { StablecoinData } from "../../../src/lib/types";
import { sumPegBuckets } from "../../../src/lib/supply";
import { withErrorHandler, addFreshnessHeaders, errorResponse, jsonResponse } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import { loadStablecoinsCache } from "../lib/stablecoins-cache";
import { derivePegAnalyticsSnapshot } from "../lib/peg-analytics";
import {
  DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
  DEPEG_DEWS_METHODOLOGY_VERSION,
  DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
  getDepegDewsMethodologyVersionAt,
  toDepegDewsMethodologyVersionLabel,
} from "../../../src/lib/depeg-dews-version";

export const handlePegSummary = withErrorHandler("peg-summary", async (db: D1Database): Promise<Response> => {
  // 1. Load stablecoins cache (live prices)
  const stablecoinsCache = await loadStablecoinsCache(db, { mode: "strict", allowLegacyArray: true });
  if (!stablecoinsCache.ok) {
    if (stablecoinsCache.reason === "missing-cache") {
      return errorResponse(503, "Data not yet available");
    }
    return errorResponse(503, "Cached stablecoins data is corrupt");
  }
  if (stablecoinsCache.updatedAt == null) {
    return errorResponse(503, "Data not yet available");
  }
  const { peggedAssets, fxFallbackRates } = stablecoinsCache.payload as {
    peggedAssets: StablecoinData[];
    fxFallbackRates?: Record<string, number>;
  };

  // 2. Load DEX prices + shared peg analytics snapshot
  const dexPriceResult = await db.prepare("SELECT * FROM dex_prices").all<{
    stablecoin_id: string;
    dex_price_usd: number;
    deviation_from_primary_bps: number | null;
    source_pool_count: number;
    source_total_tvl: number;
    updated_at: number;
  }>().catch(() => ({ results: [] as never[] }));
  const pegAnalytics = await derivePegAnalyticsSnapshot(db, {
    peggedAssets,
    fxFallbackRates,
    methodologyAsOf: stablecoinsCache.updatedAt,
    includeNavTokens: false,
  });
  const allEvents = pegAnalytics.allEvents;
  const pegDataById = pegAnalytics.pegDataById;
  const now = pegAnalytics.nowSec;

  // Build DEX price lookup (empty if migration 0011 not yet applied)
  const dexPrices = new Map(
    (dexPriceResult.results ?? []).map((r) => [r.stablecoin_id, r])
  );

  // 3. Build lookup maps
  const metaById = new Map(TRACKED_STABLECOINS.map((s) => [s.id, s]));
  const priceById = new Map(peggedAssets.map((a) => [a.id, a]));
  const { rates: pegRates, sources: pegRateSources } = derivePegRates(peggedAssets, metaById, fxFallbackRates);
  const methodologyVersion = getDepegDewsMethodologyVersionAt(stablecoinsCache.updatedAt);

  // 4. Compute per-coin data
  const coins: {
    id: string;
    symbol: string;
    name: string;
    pegType: string;
    pegCurrency: string;
    governance: string;
    currentDeviationBps: number | null;
    pegScore: number | null;
    pegPct: number;
    severityScore: number;
    spreadPenalty: number;
    eventCount: number;
    worstDeviationBps: number | null;
    activeDepeg: boolean;
    lastEventAt: number | null;
    trackingSpanDays: number;
    methodologyVersion: string;
    dexPriceCheck?: {
      dexPrice: number;
      dexDeviationBps: number;
      agrees: boolean;
      sourcePools: number;
      sourceTvl: number;
    } | null;
  }[] = [];

  let activeDepegCount = 0;
  const allAbsBps: number[] = [];
  let worstCurrent: { id: string; symbol: string; bps: number } | null = null;
  let coinsAtPeg = 0;

  for (const meta of TRACKED_STABLECOINS) {
    if (meta.flags.navToken) continue;

    const pegData = pegDataById.get(meta.id);
    if (!pegData) continue;

    const asset = priceById.get(meta.id);
    const currentBps = pegData.currentDeviationBps;

    // Build DEX price check if available (only for coins with meaningful supply)
    let dexPriceCheck: typeof coins[number]["dexPriceCheck"] = null;
    const dexRow = dexPrices.get(meta.id);
    const supply = asset?.circulating
      ? sumPegBuckets(asset.circulating)
      : 0;
    if (dexRow && supply >= 1_000_000 && (now - dexRow.updated_at) < DEX_PRICE_CHECK_FRESHNESS_SEC) {
      const pegRef = asset?.price != null && typeof asset.price === "number"
        ? getPegReference(asset.pegType, pegRates, meta.commodityOunces)
        : 0;
      if (pegRef > 0) {
        const dexBps = Math.round(((dexRow.dex_price_usd / pegRef) - 1) * 10000);
        // "agrees" = both sources within 50bps of each other (signed comparison
        // catches opposite-direction disagreements, e.g. +200bps vs -200bps)
        const agrees = currentBps != null
          ? Math.abs(currentBps - dexBps) < 50
          : Math.abs(dexBps) < 50;
        dexPriceCheck = {
          dexPrice: dexRow.dex_price_usd,
          dexDeviationBps: dexBps,
          agrees,
          sourcePools: dexRow.source_pool_count,
          sourceTvl: dexRow.source_total_tvl,
        };
      }
    }

    coins.push({
      id: meta.id,
      symbol: meta.symbol,
      name: meta.name,
      pegType: pegData.pegType,
      pegCurrency: meta.flags.pegCurrency,
      governance: meta.flags.governance,
      currentDeviationBps: currentBps,
      pegScore: pegData.pegScore,
      pegPct: pegData.pegPct,
      severityScore: pegData.severityScore,
      spreadPenalty: pegData.spreadPenalty,
      eventCount: pegData.eventCount,
      worstDeviationBps: pegData.worstDeviationBps,
      activeDepeg: pegData.activeDepeg,
      lastEventAt: pegData.lastEventAt,
      trackingSpanDays: pegData.trackingSpanDays,
      methodologyVersion,
      dexPriceCheck: dexPriceCheck ?? undefined,
    });

    // Summary aggregation
    if (pegData.activeDepeg) activeDepegCount++;
    if (currentBps !== null) {
      const absBps = Math.abs(currentBps);
      allAbsBps.push(absBps);
      if (absBps < 100) coinsAtPeg++;
      if (!worstCurrent || absBps > Math.abs(worstCurrent.bps)) {
        worstCurrent = { id: meta.id, symbol: meta.symbol, bps: currentBps };
      }
    }
  }

  // Count depeg events started today vs yesterday (UTC day boundaries)
  const todayStart = Math.floor(now / 86400) * 86400;
  const yesterdayStart = todayStart - 86400;
  let depegEventsToday = 0;
  let depegEventsYesterday = 0;
  for (const e of allEvents) {
    if (e.startedAt >= todayStart) depegEventsToday++;
    else if (e.startedAt >= yesterdayStart) depegEventsYesterday++;
  }

  // Median deviation
  allAbsBps.sort((a, b) => a - b);
  const medianBps = allAbsBps.length > 0
    ? allAbsBps.length % 2 === 0
      ? Math.round((allAbsBps[allAbsBps.length / 2 - 1] + allAbsBps[allAbsBps.length / 2]) / 2)
      : allAbsBps[Math.floor(allAbsBps.length / 2)]
    : 0;

  // Flag peg types using fallback rates so frontend can signal stale data
  const fallbackPegTypes = Object.entries(pegRateSources)
    .filter(([, src]) => src === "fallback")
    .map(([peg]) => peg);

  return jsonResponse({
    coins,
    summary: {
      activeDepegCount,
      medianDeviationBps: medianBps,
      worstCurrent,
      coinsAtPeg,
      totalTracked: coins.length,
      depegEventsToday,
      depegEventsYesterday,
      ...(fallbackPegTypes.length > 0 ? { fallbackPegRates: fallbackPegTypes } : {}),
    },
    methodology: {
      version: methodologyVersion,
      versionLabel: toDepegDewsMethodologyVersionLabel(methodologyVersion),
      currentVersion: DEPEG_DEWS_METHODOLOGY_VERSION,
      currentVersionLabel: DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
      changelogPath: DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
      asOf: stablecoinsCache.updatedAt,
      isCurrent: methodologyVersion === DEPEG_DEWS_METHODOLOGY_VERSION,
    },
  }, addFreshnessHeaders({
    "Cache-Control": CACHE_PROFILES.realtime,
  }, stablecoinsCache.updatedAt, 900));
});
