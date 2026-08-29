import { logWorkerEventArgs } from "../lib/structured-log";
import { derivePegRates, getPegReference } from "@shared/lib/peg-rates";
import { pegTypeFromCurrency } from "@shared/lib/peg-taxonomy";
import { medianOfRounded } from "@shared/lib/peg-utils";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { bucketUnixSecondsToUtcDay } from "@shared/lib/time-buckets";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { PegSummaryCoin, StablecoinData } from "@shared/types/market";
import { getCirculatingRaw } from "@shared/lib/supply";
import { addFreshnessHeaders } from "../lib/api-freshness";
import { errorResponse, jsonResponse } from "../lib/api-response";
import { buildMethodologyEnvelope } from "../lib/api-methodology";
import { CACHE_PROFILES, getDepegThresholdBps } from "../lib/constants";
import { loadStablecoinsCache } from "../lib/stablecoins-cache";
import { derivePegAnalyticsSnapshot } from "../lib/peg-analytics";
import { loadPegAnalyticsCache } from "../lib/peg-analytics-cache";
import { classifyPrimaryDepegTrust, isTrustedDexPriceRow } from "../lib/depeg-trust-policy";
import { deriveDepegSignal } from "../lib/depeg-signals";
import {
  DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
  DEPEG_DEWS_METHODOLOGY_VERSION,
  DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
  getDepegDewsMethodologyVersionAt,
} from "@shared/lib/methodology-versions/depeg-dews";
import { toMethodologyVersionLabel } from "@shared/lib/methodology-versions/base";
import { DEPEG_EVENT_MIN_SUPPLY_USD } from "@shared/lib/depeg-config";

function deriveDexDeviationBps(
  dexPriceUsd: number,
  pegType: string | null,
  pegRates: Record<string, number>,
  commodityOunces: number | undefined,
  currentDeviationBps: number | null,
  dexVsPrimaryBps: number | null,
): number | null {
  const pegRef = pegType
    ? getPegReference(pegType, pegRates, commodityOunces)
    : null;
  if (pegRef != null && Number.isFinite(pegRef) && pegRef > 0 && Number.isFinite(dexPriceUsd) && dexPriceUsd > 0) {
    return deriveDepegSignal(dexPriceUsd, pegRef)?.bps ?? null;
  }
  if (currentDeviationBps != null && dexVsPrimaryBps != null) {
    const currentMultiplier = 1 + currentDeviationBps / 10000;
    const dexVsPrimaryMultiplier = 1 + dexVsPrimaryBps / 10000;
    return Math.round(((currentMultiplier * dexVsPrimaryMultiplier) - 1) * 10000);
  }
  return null;
}

export const __pegSummaryTestHooks = {
  deriveDexDeviationBps,
  normalizePegTypeFromCurrency: pegTypeFromCurrency,
};

function deriveCurrentDeviationBps(
  asset: StablecoinData | undefined,
  pegData: PegSummaryCoin,
  isNavToken: boolean,
): number | null {
  if (isNavToken || pegData.pegReferenceUnavailable === true) return null;
  const price = asset?.price;
  const pegReference = pegData.pegReference?.valueUsd;
  return price == null || pegReference == null
    ? null
    : deriveDepegSignal(price, pegReference)?.bps ?? null;
}

export const handlePegSummary = async (db: D1Database): Promise<Response> => {
  // 1. Load stablecoins cache (live prices)
  const stablecoinsCache = await loadStablecoinsCache(db, { mode: "strict" });
  if (stablecoinsCache.kind !== "ok") {
    if (stablecoinsCache.reason === "missing-cache") {
      return errorResponse(503, "Data not yet available");
    }
    return errorResponse(503, "Cached stablecoins data is corrupt");
  }
  const { peggedAssets, fxFallbackRates } = stablecoinsCache.payload as {
    peggedAssets: StablecoinData[];
    fxFallbackRates?: Record<string, number>;
  };

  // 2. Load DEX prices + shared peg analytics snapshot
  // Narrower column set than dex-liquidity endpoint. Catch pattern mirrors depeg-helpers.ts loadDexPriceRows() (M-3).
  const [dexPriceResult, pegAnalyticsCache] = await Promise.all([
    db.prepare("SELECT stablecoin_id, dex_price_usd, deviation_from_primary_bps, source_pool_count, source_total_tvl, updated_at FROM dex_prices").all<{
      stablecoin_id: string;
      dex_price_usd: number;
      deviation_from_primary_bps: number | null;
      source_pool_count: number;
      source_total_tvl: number;
      updated_at: number;
    }>().catch((err) => {
      logWorkerEventArgs("api", "warn",
        "[peg-summary] DEX price query failed, falling back to empty:",
        err instanceof Error ? err.message : err,
      );
      return { results: [] as never[] };
    }),
    // Producer-published by the quarter-hourly report-cards pass; the direct
    // compute below re-scans ~21K depeg_events rows, so it is fallback-only.
    loadPegAnalyticsCache(db).catch(() => ({ kind: "miss" as const, reason: "missing-cache" as const })),
  ]);

  let pegDataById: ReadonlyMap<string, PegSummaryCoin>;
  let depegEventsToday: number;
  let depegEventsYesterday: number;
  // Historical peg fields can lag the live stablecoins cache by up to 30 min,
  // so key response freshness to the older of the two observations. Current
  // deviation is recomputed below from the live price and snapshot reference.
  let freshnessAsOf = stablecoinsCache.updatedAt;
  const now = Math.floor(Date.now() / 1000);

  if (pegAnalyticsCache.kind === "ok") {
    pegDataById = pegAnalyticsCache.pegDataById;
    depegEventsToday = pegAnalyticsCache.payload.depegEventsToday;
    depegEventsYesterday = pegAnalyticsCache.payload.depegEventsYesterday;
    freshnessAsOf = Math.min(freshnessAsOf, pegAnalyticsCache.payload.computedAtSec);
  } else {
    const pegAnalytics = await derivePegAnalyticsSnapshot(db, {
      peggedAssets,
      fxFallbackRates,
      methodologyAsOf: stablecoinsCache.updatedAt,
      includeNavTokens: true,
    });
    pegDataById = pegAnalytics.pegDataById;
    // Count depeg events started today vs yesterday (UTC day boundaries)
    const todayStartSec = bucketUnixSecondsToUtcDay(pegAnalytics.nowSec);
    const yesterdayStartSec = todayStartSec - DAY_SECONDS;
    depegEventsToday = 0;
    depegEventsYesterday = 0;
    for (const event of pegAnalytics.allEvents) {
      if (TRACKED_META_BY_ID.get(event.stablecoinId)?.flags.navToken === true) continue;
      if (event.startedAt >= todayStartSec) depegEventsToday += 1;
      else if (event.startedAt >= yesterdayStartSec) depegEventsYesterday += 1;
    }
  }

  // Build DEX price lookup (empty if migration 0011 not yet applied)
  const dexPrices = new Map(
    (dexPriceResult.results ?? []).map((r) => [r.stablecoin_id, r])
  );

  // 3. Build lookup maps
  const priceById = new Map(peggedAssets.map((a) => [a.id, a]));
  const { rates: pegRates, sources: pegRateSources } = derivePegRates(peggedAssets, TRACKED_META_BY_ID, fxFallbackRates);
  const methodologyVersion = getDepegDewsMethodologyVersionAt(stablecoinsCache.updatedAt);

  // 4. Compute per-coin data
  const coins: PegSummaryCoin[] = [];

  let activeDepegCount = 0;
  const allAbsBps: number[] = [];
  let worstCurrent: { id: string; symbol: string; bps: number } | null = null;
  let coinsAtPeg = 0;
  let totalTracked = 0;

  for (const meta of TRACKED_META_BY_ID.values()) {
    const isNavToken = meta.flags.navToken === true;

    const pegData = pegDataById.get(meta.id);
    if (!pegData) continue;

    const asset = priceById.get(meta.id);
    const currentBps = deriveCurrentDeviationBps(asset, pegData, isNavToken);
    // NAV score fields are normalized at the peg-analytics source via
    // NULL_PEG_SCORE_RESULT; only live deviation is withheld again here.
    const primaryTrust = asset ? classifyPrimaryDepegTrust(asset, now) : "unusable";

    // Build DEX price check if available (only for coins with meaningful
    // supply). Skipped when the peg-reference authority gate withheld the
    // deviation: the DEX cross-check would compare against the same untrusted
    // self-referential reference, publishing an agrees/disagrees signal beside
    // "ref n/a".
    let dexPriceCheck: typeof coins[number]["dexPriceCheck"] = null;
    const dexRow = dexPrices.get(meta.id);
    const supply = asset ? getCirculatingRaw(asset) : 0;
    if (
      pegData.pegReferenceUnavailable !== true &&
      dexRow && supply >= DEPEG_EVENT_MIN_SUPPLY_USD && isTrustedDexPriceRow(dexRow, now, "ui")
    ) {
      const pegType = pegData.pegType || asset?.pegType || pegTypeFromCurrency(meta.flags.pegCurrency) || null;
      const dexBps = deriveDexDeviationBps(
        dexRow.dex_price_usd,
        pegType,
        pegRates,
        meta.commodityOunces,
        currentBps,
        dexRow.deviation_from_primary_bps,
      );
      if (dexBps != null) {
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
      pegReference: pegData.pegReference,
      pegReferenceUnavailable: pegData.pegReferenceUnavailable,
      depegEventCoverageLimited: pegData.depegEventCoverageLimited,
      pegScore: pegData.pegScore,
      priceSource: asset?.priceSource,
      priceConfidence: asset?.priceConfidence ?? null,
      priceObservedAt: asset?.priceObservedAt ?? null,
      priceObservedAtMode: asset?.priceObservedAtMode ?? null,
      priceSyncedAt: asset?.priceSyncedAt ?? null,
      priceUpdatedAt: asset?.priceUpdatedAt ?? null,
      consensusSources: asset?.consensusSources,
      agreeSources: asset?.agreeSources,
      primaryTrust,
      pegPct: pegData.pegPct,
      severityScore: pegData.severityScore,
      spreadPenalty: pegData.spreadPenalty,
      eventCount: pegData.eventCount,
      worstDeviationBps: pegData.worstDeviationBps,
      activeDepeg: pegData.activeDepeg,
      lastEventAt: pegData.lastEventAt,
      trackingSpanDays: pegData.trackingSpanDays,
      historyCoverage: pegData.historyCoverage,
      recent90d: pegData.recent90d,
      methodologyVersion,
      dexPriceCheck: dexPriceCheck ?? undefined,
    });

    // Summary aggregation
    if (!isNavToken && pegData.activeDepeg) activeDepegCount++;
    if (currentBps !== null) {
      // Keep summary aggregates aligned to rows with a live peg status.
      totalTracked++;
      const absBps = Math.abs(currentBps);
      allAbsBps.push(absBps);
      const pegThreshold = getDepegThresholdBps(pegData.pegType || asset?.pegType);
      if (absBps < pegThreshold) coinsAtPeg++;
      if (!worstCurrent || absBps > Math.abs(worstCurrent.bps)) {
        worstCurrent = { id: meta.id, symbol: meta.symbol, bps: currentBps };
      }
    }
  }

  // Median deviation
  const medianBps = medianOfRounded(allAbsBps);

  // Flag peg types using fallback rates so frontend can signal stale data
  const fallbackPegTypes = Object.entries(pegRateSources)
    .filter(([, src]) => src === "fallback")
    .map(([peg]) => peg);
  const fxPegTypes = Object.entries(pegRateSources)
    .filter(([, src]) => src === "fx")
    .map(([peg]) => peg);

  return jsonResponse({
    coins,
    summary: {
      activeDepegCount,
      medianDeviationBps: medianBps,
      worstCurrent,
      coinsAtPeg,
      totalTracked,
      depegEventsToday,
      depegEventsYesterday,
      ...(fallbackPegTypes.length > 0 ? { fallbackPegRates: fallbackPegTypes } : {}),
      ...(fxPegTypes.length > 0 ? { fxPegRates: fxPegTypes } : {}),
    },
    methodology: buildMethodologyEnvelope({
      version: methodologyVersion,
      versionLabel: toMethodologyVersionLabel(methodologyVersion),
      currentVersion: DEPEG_DEWS_METHODOLOGY_VERSION,
      currentVersionLabel: DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
      changelogPath: DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
      asOf: freshnessAsOf,
    }),
  }, {
    headers: addFreshnessHeaders(
      { "Cache-Control": CACHE_PROFILES.producerBacked },
      freshnessAsOf,
      API_FRESHNESS_MAX_AGE_SEC.pegSummary,
    ),
  });
};
