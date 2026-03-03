import { getCache, getFirstSeenDates } from "../lib/db";
import { DEX_FRESHNESS_SEC } from "../lib/constants";
import { type DepegRow, rowToDepegEvent } from "../lib/depeg-helpers";
import { computePegScore, coinTrackingStart } from "../../../src/lib/peg-score";
import { derivePegRates, getPegReference } from "../../../src/lib/peg-rates";
import { TRACKED_STABLECOINS } from "../../../src/lib/stablecoins";
import type { StablecoinData, DepegEvent } from "../../../src/lib/types";
import { sumPegBuckets } from "../../../src/lib/supply";
import { withErrorHandler, addFreshnessHeaders, errorResponse, jsonResponse } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import {
  DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
  DEPEG_DEWS_METHODOLOGY_VERSION,
  DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
  getDepegDewsMethodologyVersionAt,
  toDepegDewsMethodologyVersionLabel,
} from "../../../src/lib/depeg-dews-version";

export const handlePegSummary = withErrorHandler("peg-summary", async (db: D1Database): Promise<Response> => {
  // 1. Load stablecoins cache (live prices)
  const cached = await getCache(db, "stablecoins");
  if (!cached) {
    return errorResponse(503, "Data not yet available");
  }
  const { peggedAssets, fxFallbackRates } = JSON.parse(cached.value) as { peggedAssets: StablecoinData[]; fxFallbackRates?: Record<string, number> };

  // 2. Load depeg events (4-year window matching peg score computation), DEX prices, and first-seen dates from DB
  const fourYearsAgoSec = Math.floor(Date.now() / 1000) - Math.ceil(4 * 365.25 * 86400);
  const [eventsResult, dexPriceResult, firstSeenMap] = await Promise.all([
    db.prepare("SELECT * FROM depeg_events WHERE started_at > ? ORDER BY started_at DESC").bind(fourYearsAgoSec).all<DepegRow>(),
    db.prepare("SELECT * FROM dex_prices").all<{
      stablecoin_id: string;
      dex_price_usd: number;
      deviation_from_primary_bps: number | null;
      source_pool_count: number;
      source_total_tvl: number;
      updated_at: number;
    }>().catch(() => ({ results: [] as never[] })),
    getFirstSeenDates(db),
  ]);
  const allEvents = (eventsResult.results ?? []).map(rowToDepegEvent);

  // Build DEX price lookup (empty if migration 0011 not yet applied)
  const dexPrices = new Map(
    (dexPriceResult.results ?? []).map((r) => [r.stablecoin_id, r])
  );

  // Group events by stablecoin ID
  const eventsByCoins = new Map<string, DepegEvent[]>();
  for (const e of allEvents) {
    const list = eventsByCoins.get(e.stablecoinId) ?? [];
    list.push(e);
    eventsByCoins.set(e.stablecoinId, list);
  }

  // 3. Build lookup maps
  const metaById = new Map(TRACKED_STABLECOINS.map((s) => [s.id, s]));
  const priceById = new Map(peggedAssets.map((a) => [a.id, a]));
  const { rates: pegRates, sources: pegRateSources } = derivePegRates(peggedAssets, metaById, fxFallbackRates);
  const now = Math.floor(Date.now() / 1000);
  const methodologyVersion = getDepegDewsMethodologyVersionAt(cached.updatedAt);

  // 4-year-ago fallback for tracking start
  const fourYearsAgo = now - 4 * 365.25 * 86400;

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

    const asset = priceById.get(meta.id);
    const events = eventsByCoins.get(meta.id) ?? [];

    // Current deviation
    let currentBps: number | null = null;
    if (asset?.price != null && typeof asset.price === "number" && !isNaN(asset.price)) {
      const supply = asset.circulating
        ? sumPegBuckets(asset.circulating)
        : 0;
      if (supply >= 1_000_000) {
        const pegRef = getPegReference(asset.pegType, pegRates, meta.commodityOunces);
        if (pegRef > 0) {
          currentBps = Math.round(((asset.price / pegRef) - 1) * 10000);
        }
      }
    }

    // Peg score
    const trackingStart = coinTrackingStart(events, fourYearsAgo, firstSeenMap.get(meta.id));
    const scoreResult = computePegScore(events, trackingStart, now);

    // Build DEX price check if available (only for coins with meaningful supply)
    let dexPriceCheck: typeof coins[number]["dexPriceCheck"] = null;
    const dexRow = dexPrices.get(meta.id);
    const supply = asset?.circulating
      ? sumPegBuckets(asset.circulating)
      : 0;
    if (dexRow && supply >= 1_000_000 && (now - dexRow.updated_at) < DEX_FRESHNESS_SEC) {
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
      pegType: asset?.pegType ?? "",
      pegCurrency: meta.flags.pegCurrency,
      governance: meta.flags.governance,
      currentDeviationBps: currentBps,
      pegScore: scoreResult.pegScore,
      pegPct: scoreResult.pegPct,
      severityScore: scoreResult.severityScore,
      spreadPenalty: scoreResult.spreadPenalty,
      eventCount: scoreResult.eventCount,
      worstDeviationBps: scoreResult.worstDeviationBps,
      activeDepeg: scoreResult.activeDepeg,
      lastEventAt: scoreResult.lastEventAt,
      trackingSpanDays: scoreResult.trackingSpanDays,
      methodologyVersion,
      dexPriceCheck: dexPriceCheck ?? undefined,
    });

    // Summary aggregation
    if (scoreResult.activeDepeg) activeDepegCount++;
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
      asOf: cached.updatedAt,
      isCurrent: methodologyVersion === DEPEG_DEWS_METHODOLOGY_VERSION,
    },
  }, addFreshnessHeaders({
    "Cache-Control": CACHE_PROFILES.realtime,
  }, cached.updatedAt, 900));
});
