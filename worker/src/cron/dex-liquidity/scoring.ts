import { ACTIVE_IDS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { roundTo } from "@shared/lib/math";
import { buildP4DexExitRouteObservations } from "@shared/lib/p4-exit-route-capacity";
import type { ExitRouteObservation, ExitRouteObservationCoverage } from "@shared/types/market";
import { rethrowIfAborted, throwIfAborted } from "../../lib/abort";
import { batchExecute } from "../../lib/db";
import { DEX_LIQUIDITY_PUBLISHED_ROW_FILTER } from "../../lib/dex-liquidity";
import { loadStablecoinsCache } from "../../lib/stablecoins-cache";
import type { PriceValidationReferences } from "../../lib/price-validation";
import type { LiquidityMetrics, FullScoreResult, GlobalAgg } from "./types";
import { dexPriceConfidenceForSourceFamily } from "./constants";
import { computeDurabilityScore, computeLiquidityScore } from "./pool-helpers";
import { isPlausibleDexObservationPrice } from "./price-sanity";
import {
  accumulateGlobalAggregate,
  aggregateProtocolSources,
  applyProtocolCaps,
  applyRebuiltMetrics,
  buildDexPriceObservationsFromRetainedPools,
  classifyCoverage,
  collapseDuplicateObservations,
  filterRetainedPools,
  rebuildMetricsFromPools,
} from "./scoring-helpers";

const HISTORY_CONFIDENCE_MIN = 0.75;
const MIN_STABILITY_SAMPLES = 7;
const PRIMARY_PRICE_OUTLIER_MAX_DEVIATION_RATIO = 2.5;
const DISPLAY_PRICE_RATIO_MIN = 0.5,
  DISPLAY_PRICE_RATIO_MAX = 2.0;

interface ProtocolCapDiagnostics {
  cappedPoolCount: number;
  cappedProtocols: number;
  reducedTvlUsd: number;
}

interface ScoreDiagnostics {
  protocolCapReductions: ProtocolCapDiagnostics;
}

type P4aFullScoreResult = FullScoreResult & {
  exitRouteObservations: ExitRouteObservation[];
  exitRouteObservationCoverage: ExitRouteObservationCoverage;
};

/** @internal Exported for testing only. */
export function computeSeriesStability(values: number[]): number | null {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length < MIN_STABILITY_SAMPLES) return null;
  const mean = finite.reduce((sum, value) => sum + value, 0) / finite.length;
  if (mean <= 0) return null;
  const variance = finite.reduce((sum, value) => sum + (value - mean) ** 2, 0) / finite.length;
  const cv = Math.sqrt(Math.max(0, variance)) / mean;
  return Math.round((1 - Math.min(1, cv)) * 10000) / 10000;
}

function weightedRatio(sum: number, total: number, places = 4): number | null {
  return total > 0 ? roundTo(sum / total, places) : null;
}

async function loadConfidentHistoryStability(db: D1Database): Promise<{
  tvlStabilityMap: Map<string, number>;
  volumeStabilityMap: Map<string, number>;
}> {
  const todayMidnight = Math.floor(Date.now() / 86_400_000) * 86_400;
  const thirtyDaysAgo = todayMidnight - 30 * 86_400;
  const tvlStabilityMap = new Map<string, number>();
  const volumeStabilityMap = new Map<string, number>();

  const histRows = await db
    .prepare(
      `SELECT stablecoin_id, total_tvl_usd, total_volume_24h_usd, coverage_confidence
       FROM dex_liquidity_history
       WHERE snapshot_date >= ?
       ORDER BY stablecoin_id, snapshot_date`,
    )
    .bind(thirtyDaysAgo)
    .all<{
      stablecoin_id: string;
      total_tvl_usd: number;
      total_volume_24h_usd: number;
      coverage_confidence: number | null;
    }>();

  const tvlByCoin = new Map<string, number[]>();
  const volumeByCoin = new Map<string, number[]>();
  for (const row of histRows.results ?? []) {
    const confidence = row.coverage_confidence ?? 0;
    if (confidence < HISTORY_CONFIDENCE_MIN) continue;

    const tvlSeries = tvlByCoin.get(row.stablecoin_id) ?? [];
    tvlSeries.push(row.total_tvl_usd);
    tvlByCoin.set(row.stablecoin_id, tvlSeries);

    const volumeSeries = volumeByCoin.get(row.stablecoin_id) ?? [];
    volumeSeries.push(row.total_volume_24h_usd);
    volumeByCoin.set(row.stablecoin_id, volumeSeries);
  }

  for (const [coinId, tvls] of tvlByCoin) {
    const stability = computeSeriesStability(tvls);
    if (stability != null) {
      tvlStabilityMap.set(coinId, stability);
    }
  }
  for (const [coinId, volumes] of volumeByCoin) {
    const stability = computeSeriesStability(volumes);
    if (stability != null) {
      volumeStabilityMap.set(coinId, stability);
    }
  }

  return { tvlStabilityMap, volumeStabilityMap };
}

/** Compute HHI, durability, and 6-component composite score per stablecoin. */
export async function computeStablecoinScores(
  db: D1Database,
  metrics: Map<string, LiquidityMetrics>,
  protocolTvlCaps: Map<string, number>,
  mcapById?: Map<string, number>,
  routeObservedAtSec = Math.floor(Date.now() / 1000),
): Promise<{
  scores: Map<string, FullScoreResult>;
  globalAgg: GlobalAgg;
  retainedPoolsByStablecoin: Map<string, LiquidityMetrics["topPools"]>;
  tvlStabilityMap: Map<string, number>;
  diagnostics: ScoreDiagnostics;
}> {
  let tvlStabilityMap = new Map<string, number>();
  let volumeStabilityMap = new Map<string, number>();
  try {
    ({ tvlStabilityMap, volumeStabilityMap } = await loadConfidentHistoryStability(db));
  } catch {
    /* non-blocking: history stability table may not exist yet (first run / pre-migration); fall back to neutral defaults */
  }

  const results = new Map<string, FullScoreResult>();
  const retainedPoolsByStablecoin = new Map<string, LiquidityMetrics["topPools"]>();
  const routeObservedAt = Math.max(0, Math.floor(routeObservedAtSec));

  // Global dedup accumulators — accumulated per-coin BEFORE top-10 truncation
  const seenPoolTvl = new Map<string, { tvl: number; vol24h: number; vol7d: number; proto: string; chain: string }>();
  const globalProtocolTvl: Record<string, number> = {};
  const globalChainTvl: Record<string, number> = {};
  const globalProtoChainTvl: Record<string, number> = {}; // "proto:chain" → TVL
  let globalTotalTvl = 0;
  let globalTotalVol24h = 0;
  let globalTotalVol7d = 0;
  let globalPoolCount = 0;
  const globalChains = new Set<string>();
  const protocolCapDiagnostics: ProtocolCapDiagnostics = { cappedPoolCount: 0, cappedProtocols: 0, reducedTvlUsd: 0 };

  for (const [id, m] of [...metrics].filter(([stablecoinId]) => ACTIVE_IDS.has(stablecoinId))) {
    m.topPools = filterRetainedPools(m.topPools);
    const capResult = applyProtocolCaps(m.topPools, protocolTvlCaps);
    protocolCapDiagnostics.cappedPoolCount += capResult.cappedPoolCount;
    protocolCapDiagnostics.cappedProtocols += capResult.cappedProtocols;
    protocolCapDiagnostics.reducedTvlUsd += capResult.reducedTvlUsd;

    const retainedPools = [...m.topPools];
    retainedPoolsByStablecoin.set(
      id,
      retainedPools.map((pool) => ({
        ...pool,
        extra: pool.extra ? { ...pool.extra } : undefined,
      })),
    );
    const rebuilt = rebuildMetricsFromPools(retainedPools);
    const routeObservationResult = buildP4DexExitRouteObservations({
      stablecoinId: id,
      retainedPools,
      observedAt: routeObservedAt,
    });

    applyRebuiltMetrics(m, rebuilt);
    const globalDelta = accumulateGlobalAggregate(
      retainedPools,
      globalProtocolTvl,
      globalChainTvl,
      globalProtoChainTvl,
      globalChains,
      seenPoolTvl,
    );
    globalTotalTvl += globalDelta.totalTvl;
    globalTotalVol24h += globalDelta.totalVol24h;
    globalTotalVol7d += globalDelta.totalVol7d;
    globalPoolCount += globalDelta.poolCount;

    // v2: Compute durability score
    const tvlStab = tvlStabilityMap.get(id) ?? null;
    const volStab = volumeStabilityMap.get(id) ?? null;
    const durability = computeDurabilityScore(m, tvlStab, volStab);

    // v2: Compute 6-component score
    const circulatingUsd = mcapById?.get(id);
    const { score, components } = computeLiquidityScore(m, durability, circulatingUsd);

    // v2: Compute aggregate metrics
    const weightedBalanceRatio = weightedRatio(m.balanceRatioWeightedSum, m.totalTvlForBalance);
    const organicFrac = weightedRatio(m.organicTvlWeightedSum, m.totalTvlForOrganic);
    // Stored diagnostic only: stress-unmeasured TVL contributes zero stress under the current methodology.
    const avgStress = weightedRatio(m.stressWeightedSum, m.totalTvlUsd, 2);
    const lockedLiqPct = weightedRatio(m.lockedLiqWeightedSum, m.totalTvlForLocked);
    const { coverageClass, coverageConfidence } = classifyCoverage({
      sourceMix: rebuilt.sourceMix,
      totalTvlUsd: m.totalTvlUsd,
      protocolCount: rebuilt.protocolCount,
      sourceFamilyCount: rebuilt.sourceFamilyCount,
      balanceMeasuredTvlUsd: m.totalTvlForBalance,
      organicMeasuredTvlUsd: m.totalTvlForOrganic,
      syntheticTvlUsd: rebuilt.syntheticTvlUsd,
      decayedTvlUsd: rebuilt.decayedTvlUsd,
      measuredPriceTvlUsd: rebuilt.measuredPriceTvlUsd,
    });

    const fullScoreResult: P4aFullScoreResult = {
      tvl: m.totalTvlUsd,
      effectiveTvl: m.effectiveTvl,
      vol24h: m.totalVolume24hUsd,
      score,
      hhi: Math.round(rebuilt.hhi * 10000) / 10000,
      durability,
      components,
      weightedBalanceRatio,
      organicFrac,
      avgStress,
      lockedLiqPct,
      coverageClass,
      coverageConfidence,
      sourceMix: rebuilt.sourceMix,
      balanceMeasuredTvlUsd: m.totalTvlForBalance,
      organicMeasuredTvlUsd: m.totalTvlForOrganic,
      exitRouteObservations: routeObservationResult.observations,
      exitRouteObservationCoverage: routeObservationResult.coverage,
    };
    results.set(id, fullScoreResult);
  }

  // Global protocol-level TVL cap: when reducing excess, chain TVLs are
  // distributed proportionally rather than attributed to the chain with the
  // most excess. Exact chain attribution would require per-pool chain data
  // which is not available in the global aggregate.
  //
  // Clamp deduped protocol totals at DL protocol TVL.
  // After cross-stablecoin dedup, a protocol can still exceed its real TVL when
  // CG/GT virtual reserves are inflated across many pools. The per-coin cap allows
  // up to protocolTvl PER stablecoin, but globally the protocol total must not
  // exceed DL's reported TVL. Chain TVLs are reduced proportionally.
  let globalCapReduction = 0;
  for (const proto of Object.keys(globalProtocolTvl)) {
    const cap = protocolTvlCaps.get(proto);
    if (cap != null && cap > 0 && globalProtocolTvl[proto] > cap) {
      const excess = globalProtocolTvl[proto] - cap;
      globalCapReduction += excess;
      // Distribute reduction to chain TVLs proportionally
      const protoTotal = globalProtocolTvl[proto];
      for (const [pcKey, pcTvl] of Object.entries(globalProtoChainTvl)) {
        if (!pcKey.startsWith(`${proto}:`)) continue;
        const chain = pcKey.slice(proto.length + 1);
        const chainReduction = (pcTvl / protoTotal) * excess;
        globalChainTvl[chain] = Math.max(0, (globalChainTvl[chain] ?? 0) - chainReduction);
      }
      globalProtocolTvl[proto] = cap;
    }
  }
  globalTotalTvl -= globalCapReduction;

  const globalAgg: GlobalAgg = {
    totalTvl: globalTotalTvl,
    totalVol24h: globalTotalVol24h,
    totalVol7d: globalTotalVol7d,
    poolCount: globalPoolCount,
    chainCount: globalChains.size,
    protocolTvl: globalProtocolTvl,
    chainTvl: globalChainTvl,
  };

  return {
    scores: results,
    globalAgg,
    retainedPoolsByStablecoin,
    tvlStabilityMap,
    diagnostics: {
      protocolCapReductions: {
        cappedPoolCount: protocolCapDiagnostics.cappedPoolCount,
        cappedProtocols: protocolCapDiagnostics.cappedProtocols,
        reducedTvlUsd: protocolCapDiagnostics.reducedTvlUsd + Math.round(globalCapReduction),
      },
    },
  };
}

/** Compute depth stability (CV-based) and persist to D1. Accepts pre-loaded data to avoid redundant DB scan. */
export async function computeDepthStability(
  db: D1Database,
  preloadedTvlStabilityMap?: Map<string, number>,
  signal?: AbortSignal,
): Promise<void> {
  try {
    throwIfAborted(signal);
    const tvlStabilityMap = preloadedTvlStabilityMap ?? (await loadConfidentHistoryStability(db)).tvlStabilityMap;
    throwIfAborted(signal);

    const stabilityStmts: D1PreparedStatement[] = [];
    stabilityStmts.push(
      db.prepare(
        `UPDATE dex_liquidity SET depth_stability = NULL WHERE stablecoin_id != '__global__' AND ${DEX_LIQUIDITY_PUBLISHED_ROW_FILTER}`,
      ),
    );
    for (const [id, stability] of tvlStabilityMap) {
      stabilityStmts.push(
        db.prepare("UPDATE dex_liquidity SET depth_stability = ? WHERE stablecoin_id = ?").bind(stability, id),
      );
    }
    if (stabilityStmts.length > 0) {
      await batchExecute(db, stabilityStmts, { signal });
      console.log(`[dex-liquidity] Updated depth stability for ${tvlStabilityMap.size} coins`);
    }
  } catch (err) {
    rethrowIfAborted(err, signal);
    console.warn("[dex-liquidity] Depth stability computation failed:", err);
  }
}

/** Compute DEX-implied prices from the final retained pool set and persist to dex_prices. */
export async function computeDexPrices(
  db: D1Database,
  retainedPoolsByStablecoin: Map<string, LiquidityMetrics["topPools"]>,
  nowSec: number,
  references?: PriceValidationReferences,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const priceObservations = buildDexPriceObservationsFromRetainedPools(retainedPoolsByStablecoin);
  const existingRows = await db.prepare("SELECT stablecoin_id FROM dex_prices").all<{ stablecoin_id: string }>();
  const existingIds = new Set((existingRows.results ?? []).map((row) => row.stablecoin_id));
  throwIfAborted(signal);

  if (priceObservations.size === 0) {
    if (existingIds.size === 0) return;

    const retireStmts = Array.from(existingIds, (stablecoinId) =>
      db.prepare("DELETE FROM dex_prices WHERE stablecoin_id = ?").bind(stablecoinId),
    );
    await batchExecute(db, retireStmts, { signal });
    console.log(`[dex-liquidity] Retired ${retireStmts.length} DEX price rows with no current observations`);
    return;
  }

  // Load primary prices from stablecoins cache for comparison
  const primaryPrices = new Map<string, number>();
  const stablecoinsCache = await loadStablecoinsCache(db, { mode: "strict", allowLegacyArray: false });
  if (stablecoinsCache.kind === "ok") {
    for (const asset of stablecoinsCache.payload.peggedAssets) {
      if (asset.price != null && typeof asset.price === "number" && asset.price > 0) {
        primaryPrices.set(asset.id, asset.price);
      }
    }
  }

  const priceStmts: D1PreparedStatement[] = [];
  const observedIds = new Set<string>();
  let collapsedDuplicateGroups = 0;
  let collapsedDuplicateObservations = 0;
  for (const [id, observations] of priceObservations) {
    throwIfAborted(signal);
    if (observations.length === 0) continue;
    observedIds.add(id);

    const {
      collapsed: collapsedObservations,
      duplicateGroups,
      duplicateObservations,
    } = collapseDuplicateObservations(observations);
    collapsedDuplicateGroups += duplicateGroups;
    collapsedDuplicateObservations += duplicateObservations;
    if (collapsedObservations.length === 0) continue;

    // Look up primary price early — used for outlier filtering and deviation calc
    const primaryPrice = primaryPrices.get(id);

    // Filter extreme outliers relative to primary price before computing median.
    // When a source (e.g. CoinGecko aggregate) reports a price near peg for a severely
    // depegged stablecoin, its high TVL can dominate the TVL-weighted median.
    // Only apply when 3+ observations exist and majority by count agrees with primary.
    let medianInputObs = collapsedObservations;
    if (primaryPrice != null && primaryPrice > 0 && collapsedObservations.length >= 3) {
      const nearPrimary = collapsedObservations.filter((o) => {
        const ratio = o.price / primaryPrice;
        return (
          ratio >= 1 / PRIMARY_PRICE_OUTLIER_MAX_DEVIATION_RATIO && ratio <= PRIMARY_PRICE_OUTLIER_MAX_DEVIATION_RATIO
        );
      });
      if (nearPrimary.length >= 2 && nearPrimary.length > collapsedObservations.length / 2) {
        medianInputObs = nearPrimary;
      }
    }

    // Scale TVL weights by source confidence before computing median
    const adjustedObs = medianInputObs.map((o) => ({
      ...o,
      tvl: o.tvl * dexPriceConfidenceForSourceFamily(o.sourceFamily),
    }));

    // TVL-weighted median: sort by price, walk until cumulative (confidence-weighted) TVL crosses 50%
    adjustedObs.sort((a, b) => a.price - b.price);
    const adjustedTotalTvl = adjustedObs.reduce((s, o) => s + o.tvl, 0);
    const halfTvl = adjustedTotalTvl / 2;
    let cumTvl = 0;
    let medianPrice = adjustedObs[0].price;
    for (const obs of adjustedObs) {
      cumTvl += obs.tvl;
      if (cumTvl >= halfTvl) {
        medianPrice = obs.price;
        break;
      }
    }

    // Raw TVL for DB storage (represents actual on-chain liquidity, not confidence-weighted)
    const totalTvl = collapsedObservations.reduce((s, o) => s + o.tvl, 0);
    let deviationBps: number | null = null;
    if (primaryPrice != null && primaryPrice > 0) {
      deviationBps = Math.round((medianPrice / primaryPrice - 1) * 10000);
    }

    // Guard against retained pools whose prices are off-peg for the tracked stablecoin.
    // This protects price_sources_json (the "show all sources" UI) from alias-collapse
    // contamination like Fantom USDC.e rows at $0.044 flowing into usdc-circle.priceSources.
    // The scoring-level sanity gate has a wide 1% floor to avoid rejecting legitimately
    // depegged stablecoins. For the per-protocol display surface, apply a tighter 50%
    // primary-price ratio guard on top so near-peg alias-collapse rows are filtered.
    const sanePriceObs = collapsedObservations.filter((obs) => {
      if (!isPlausibleDexObservationPrice(id, obs.price, references)) return false;
      if (primaryPrice != null && primaryPrice > 0) {
        const ratio = obs.price / primaryPrice;
        if (ratio < DISPLAY_PRICE_RATIO_MIN || ratio > DISPLAY_PRICE_RATIO_MAX) return false;
      }
      return true;
    });
    const protocolSources = aggregateProtocolSources(sanePriceObs);

    const meta = TRACKED_META_BY_ID.get(id);
    const symbol = meta?.symbol ?? id;

    priceStmts.push(
      db
        .prepare(
          `INSERT INTO dex_prices
            (stablecoin_id, symbol, dex_price_usd, source_pool_count, source_total_tvl,
             deviation_from_primary_bps, primary_price_at_calc, price_sources_json, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(stablecoin_id) DO UPDATE SET
            symbol = excluded.symbol,
            dex_price_usd = excluded.dex_price_usd,
            source_pool_count = excluded.source_pool_count,
            source_total_tvl = excluded.source_total_tvl,
            deviation_from_primary_bps = excluded.deviation_from_primary_bps,
            primary_price_at_calc = excluded.primary_price_at_calc,
            price_sources_json = excluded.price_sources_json,
            updated_at = excluded.updated_at
          WHERE dex_prices.updated_at <= excluded.updated_at`,
        )
        .bind(
          id,
          symbol,
          Math.round(medianPrice * 1e6) / 1e6, // 6 decimal places
          collapsedObservations.length,
          Math.round(totalTvl),
          deviationBps,
          primaryPrice ?? null,
          JSON.stringify(protocolSources),
          nowSec,
        ),
    );
  }

  let retiredCount = 0;
  for (const existingId of existingIds) {
    throwIfAborted(signal);
    if (observedIds.has(existingId)) continue;
    priceStmts.push(db.prepare("DELETE FROM dex_prices WHERE stablecoin_id = ?").bind(existingId));
    retiredCount++;
  }

  if (priceStmts.length > 0) {
    await batchExecute(db, priceStmts, { signal });
    console.log(
      `[dex-liquidity] Wrote ${observedIds.size} DEX price observations to dex_prices` +
        (collapsedDuplicateGroups > 0
          ? ` after collapsing ${collapsedDuplicateObservations} duplicate observations across ${collapsedDuplicateGroups} pool group(s)`
          : "") +
        (retiredCount > 0 ? ` and retired ${retiredCount} stale rows` : ""),
    );
  }
}
