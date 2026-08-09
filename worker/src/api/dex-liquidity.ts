import { safeJsonParse, addFreshnessHeaders, jsonResponseWithHeaders } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import { isMissingTableError } from "../lib/db";
import { DEX_LIQUIDITY_PUBLISHED_ROW_FILTER } from "../lib/dex-liquidity";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { getLiquidityMethodologyVersionAt } from "@shared/lib/liquidity-score-version";
import {
  buildDexLiquidityWarning,
  getDexLiquidityTrendTolerances,
  normalizeDexScoreDetails,
  normalizeTopPools,
  selectTrendBaseline,
  buildDexDeploymentCoverage,
  type DexLiquidityCronRow,
  type DexDeploymentOutcomeRow,
  type DexHistoryRow,
  type DexLiquidityRow,
  type DexPriceRow,
} from "./dex-liquidity-response";
import { classifyLiquidityEvidence } from "./dex-liquidity-evidence";
import { toErrorMessage } from "../lib/error-utils";

export const handleDexLiquidity = async (db: D1Database): Promise<Response> => {
  const [result, histResult, priceResult, deploymentResult, latestCron, latestSuccessfulCron] = await Promise.all([
    db
      .prepare(
        `SELECT stablecoin_id, total_tvl_usd, total_volume_24h_usd, total_volume_7d_usd, pool_count, pair_count, chain_count, protocol_tvl_json, chain_tvl_json, top_pools_json, liquidity_score, concentration_hhi, depth_stability, updated_at, effective_tvl_usd, avg_pool_stress, weighted_balance_ratio, organic_fraction, durability_score, score_components_json, locked_liquidity_pct, coverage_class, coverage_confidence, source_mix_json, balance_measured_tvl_usd, organic_measured_tvl_usd, methodology_version
         FROM dex_liquidity
         WHERE ${DEX_LIQUIDITY_PUBLISHED_ROW_FILTER}
         ORDER BY liquidity_score DESC`,
      )
      .all<DexLiquidityRow>(),
    db
      .prepare(
        `SELECT stablecoin_id, total_tvl_usd, snapshot_date, coverage_class, coverage_confidence
         FROM dex_liquidity_history
         WHERE snapshot_date >= ?
         ORDER BY stablecoin_id, snapshot_date DESC`,
      )
      .bind(Math.floor(Date.now() / 1000) - 8 * 86_400) // 8 days back covers 7d comparison
      .all<DexHistoryRow>(),
    db
      .prepare(
        "SELECT stablecoin_id, dex_price_usd, deviation_from_primary_bps, source_pool_count, source_total_tvl, price_sources_json, updated_at FROM dex_prices",
      )
      .all<DexPriceRow>()
      .catch((err) => {
        const msg = toErrorMessage(err);
        if (isMissingTableError(err)) {
          return { results: [] as DexPriceRow[] };
        }
        console.error("[dex-liquidity] Unexpected error loading dex_prices:", msg);
        throw err;
      }),
    db
      .prepare(
        `SELECT stablecoin_id, chain, contract_address, outcome, provider_set_json, reason,
              observed_pool_count, observed_at, waiver_owner, waiver_reason, waiver_expires_at
         FROM dex_deployment_outcomes
        ORDER BY stablecoin_id, chain, contract_address`,
      )
      .all<DexDeploymentOutcomeRow>()
      .catch((err) => {
        if (isMissingTableError(err)) return { results: [] as DexDeploymentOutcomeRow[] };
        throw err;
      }),
    db
      .prepare(
        `SELECT status, metadata
         FROM cron_runs
         WHERE job = 'sync-dex-liquidity'
         ORDER BY started_at DESC
         LIMIT 1`,
      )
      .first<DexLiquidityCronRow>()
      .catch(() => null),
    db
      .prepare(
        `SELECT MAX(started_at) AS started_at
         FROM cron_runs
         WHERE job = 'sync-dex-liquidity'
           AND status = 'ok'`,
      )
      .first<{ started_at: number | null }>()
      .catch(() => null),
  ]);

  // Build DEX price lookup
  const dexPriceById = new Map<string, DexPriceRow>();
  for (const row of priceResult.results ?? []) {
    dexPriceById.set(row.stablecoin_id, row);
  }

  // Build historical TVL lookup: stablecoin_id → sorted snapshots (newest first)
  const histByCoin = new Map<string, DexHistoryRow[]>();
  for (const row of histResult.results ?? []) {
    const arr = histByCoin.get(row.stablecoin_id) ?? [];
    arr.push(row);
    histByCoin.set(row.stablecoin_id, arr);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const deploymentCoverageById = buildDexDeploymentCoverage(deploymentResult.results ?? [], nowSec);
  const oneDayAgo = nowSec - 86_400;
  const sevenDaysAgo = nowSec - 7 * 86_400;
  const { day: trend24hToleranceSec, week: trend7dToleranceSec } = getDexLiquidityTrendTolerances();

  const map: Record<string, unknown> = {};
  for (const row of result.results ?? []) {
    const id = row.stablecoin_id;
    const currentTvl = row.total_tvl_usd;

    // Compute trend changes from history
    const history = histByCoin.get(id) ?? [];
    const baseline24h = selectTrendBaseline(history, oneDayAgo, trend24hToleranceSec);
    const baseline7d = selectTrendBaseline(history, sevenDaysAgo, trend7dToleranceSec);
    const tvlChange24h = baseline24h
      ? ((currentTvl - baseline24h.total_tvl_usd) / baseline24h.total_tvl_usd) * 100
      : null;
    const tvlChange7d = baseline7d ? ((currentTvl - baseline7d.total_tvl_usd) / baseline7d.total_tvl_usd) * 100 : null;

    // Merge DEX price data if available
    const dexPrice = dexPriceById.get(id);
    const coverageClass = id === "__global__" ? null : (row.coverage_class ?? "legacy");
    const coverageConfidence = row.coverage_confidence ?? 0.5;
    const { liquidityEvidenceClass, hasMeasuredLiquidityEvidence, trendworthy } = classifyLiquidityEvidence(
      currentTvl,
      coverageClass,
      coverageConfidence,
    );
    const balanceMeasuredTvlUsd = row.balance_measured_tvl_usd ?? 0;
    const scoreDetails = normalizeDexScoreDetails(
      row.score_components_json,
      `dex-liquidity:${id}:score_components_json`,
    );

    map[id] = {
      totalTvlUsd: currentTvl,
      totalVolume24hUsd: row.total_volume_24h_usd,
      totalVolume7dUsd: row.total_volume_7d_usd,
      poolCount: row.pool_count,
      pairCount: row.pair_count,
      chainCount: row.chain_count,
      protocolTvl: safeJsonParse<Record<string, number>>(
        row.protocol_tvl_json,
        {},
        `dex-liquidity:${id}:protocol_tvl_json`,
      ),
      chainTvl: safeJsonParse<Record<string, number>>(row.chain_tvl_json, {}, `dex-liquidity:${id}:chain_tvl_json`),
      topPools: normalizeTopPools(row.top_pools_json, `dex-liquidity:${id}:top_pools_json`),
      liquidityScore: row.liquidity_score,
      concentrationHhi: row.concentration_hhi,
      depthStability: row.depth_stability,
      tvlChange24h: tvlChange24h != null ? Math.round(tvlChange24h * 100) / 100 : null,
      tvlChange7d: tvlChange7d != null ? Math.round(tvlChange7d * 100) / 100 : null,
      updatedAt: row.updated_at,
      dexPriceUsd: dexPrice?.dex_price_usd ?? null,
      dexDeviationBps: dexPrice?.deviation_from_primary_bps ?? null,
      priceSourceCount: dexPrice?.source_pool_count ?? null,
      priceSourceTvl: dexPrice?.source_total_tvl ?? null,
      priceSources: safeJsonParse<unknown[] | null>(
        dexPrice?.price_sources_json,
        null,
        `dex-liquidity:${id}:price_sources_json`,
      ),
      // v2 fields
      effectiveTvlUsd: row.effective_tvl_usd ?? 0,
      avgPoolStress: row.avg_pool_stress ?? null,
      weightedBalanceRatio: row.weighted_balance_ratio ?? null,
      organicFraction: row.organic_fraction ?? null,
      durabilityScore: row.durability_score ?? null,
      coverageClass,
      coverageConfidence,
      liquidityEvidenceClass,
      hasMeasuredLiquidityEvidence,
      trendworthy,
      sourceMix: safeJsonParse<Record<string, { poolCount: number; tvlUsd: number }>>(
        row.source_mix_json,
        {},
        `dex-liquidity:${id}:source_mix_json`,
      ),
      balanceMeasuredTvlUsd,
      organicMeasuredTvlUsd: row.organic_measured_tvl_usd ?? 0,
      scoreComponents: scoreDetails.scoreComponents,
      lockedLiquidityPct: row.locked_liquidity_pct ?? null,
      methodologyVersion: row.methodology_version ?? getLiquidityMethodologyVersionAt(row.updated_at),
      deploymentCoverage: deploymentCoverageById.get(id) ?? null,
      exitRouteObservations: scoreDetails.exitRouteObservations,
      exitRouteObservationCoverage: scoreDetails.exitRouteObservationCoverage,
    };
  }

  const rows = result.results ?? [];
  const latestRowUpdate =
    rows.length > 0 ? rows.reduce((m, r) => Math.max(m, r.updated_at), 0) : Math.floor(Date.now() / 1000);
  const freshnessTs = latestSuccessfulCron?.started_at ?? latestRowUpdate;

  const headers = addFreshnessHeaders(
    {
      "Cache-Control": CACHE_PROFILES.custom,
    },
    freshnessTs,
    API_FRESHNESS_MAX_AGE_SEC.dexLiquidity,
  );
  const degradedWarning = buildDexLiquidityWarning(latestCron);
  if (degradedWarning) {
    headers.Warning = headers.Warning ? `${headers.Warning}, ${degradedWarning}` : degradedWarning;
  }

  return jsonResponseWithHeaders(map, headers);
};
