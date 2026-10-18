import { logWorkerEventArgs } from "../lib/structured-log";
import { safeJsonParse } from "../lib/api-cache-read";
import { addFreshnessHeaders, buildCronFreshnessHeaders, getLatestSuccessfulCronTimestampResult } from "../lib/api-freshness";
import { jsonResponseWithHeaders } from "../lib/api-response";
import { API_CACHE_PROFILES as CACHE_PROFILES } from "@shared/lib/api-cache-profiles";
import { isMissingTableError } from "../lib/db";
import {
  DEX_LIQUIDITY_PUBLISHED_ROW_FILTER,
  dexLiquidityPublishedRowFilter,
  normalizeDexLiquidityEvidence,
  type DexLiquidityRow,
  type NormalizedDexLiquidityEvidence,
} from "../lib/dex-liquidity";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
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
  type DexPriceRow,
} from "../lib/dex-liquidity-response";
import { toErrorMessage } from "@shared/lib/error-utils";
import { parseDexVolumeAvailabilityRecord, readStoredDexVolumeWindow } from "@shared/lib/dex-volume-availability";
import { assessFreshnessTimestamp } from "../lib/api-freshness-age";
import { STAGED_POOL_PRICE_MAX_AGE_HOURS } from "../lib/dex-cron-constants";
import { readCoinProjectionId } from "../lib/api-coin-projection";
import type { DexLiquidityData, DexLiquidityTableMap } from "@shared/types/market";

export const handleDexLiquidity = async (
  db: D1Database,
  stablecoinId?: string,
  tableProjection = false,
): Promise<Response> => {
  const coinFilter = stablecoinId ? " AND stablecoin_id = ?" : "";
  const coinBindings = stablecoinId ? [stablecoinId] : [];
  const [result, histResult, priceResult, deploymentResult, cronRead] = await Promise.all([
    db
      .prepare(
        // SAFETY: projections, FROM/join shape, aliases and filters are fixed internal SQL; coin values are bound.
        `SELECT ${tableProjection
          ? "stablecoin_id, total_tvl_usd, liquidity_score, updated_at, coverage_class, coverage_confidence, methodology_version"
          : "stablecoin_id, total_tvl_usd, total_volume_24h_usd, total_volume_7d_usd, total_volume_7d_measured, volume_availability_json, pool_count, pair_count, chain_count, protocol_tvl_json, chain_tvl_json, top_pools_json, liquidity_score, concentration_hhi, depth_stability, updated_at, effective_tvl_usd, avg_pool_stress, weighted_balance_ratio, organic_fraction, durability_score, score_components_json, locked_liquidity_pct, coverage_class, coverage_confidence, source_mix_json, balance_measured_tvl_usd, organic_measured_tvl_usd, methodology_version"}
         , publication_generation_id${stablecoinId ? ", dataset.totalCount AS projection_total_count" : ""}
         FROM ${stablecoinId ? `(SELECT COUNT(*) AS totalCount FROM dex_liquidity
           WHERE ${DEX_LIQUIDITY_PUBLISHED_ROW_FILTER}) dataset
           LEFT JOIN dex_liquidity ON ${dexLiquidityPublishedRowFilter("dex_liquidity")}${coinFilter}` :
           `dex_liquidity WHERE ${DEX_LIQUIDITY_PUBLISHED_ROW_FILTER}`}
         ORDER BY liquidity_score DESC`,
      )
      .bind(...coinBindings)
      .all<DexLiquidityRow & { publication_generation_id: string | null; projection_total_count?: number }>(),
    tableProjection ? Promise.resolve({ results: [] as DexHistoryRow[] }) : db
      .prepare(
        `SELECT stablecoin_id, total_tvl_usd, snapshot_date, coverage_class, coverage_confidence
         FROM dex_liquidity_history
         WHERE snapshot_date >= ?${coinFilter}
         ORDER BY stablecoin_id, snapshot_date DESC`,
      )
      .bind(Math.floor(Date.now() / 1000) - 8 * 86_400, ...coinBindings)
      .all<DexHistoryRow>(),
    tableProjection ? Promise.resolve({ results: [] as DexPriceRow[] }) : db
      .prepare(
        `SELECT stablecoin_id, dex_price_usd, deviation_from_primary_bps, source_pool_count, source_total_tvl, price_sources_json, updated_at FROM dex_prices WHERE 1 = 1${coinFilter}`,
      )
      .bind(...coinBindings)
      .all<DexPriceRow>()
      .catch((err) => {
        const msg = toErrorMessage(err);
        if (isMissingTableError(err)) {
          return { results: [] as DexPriceRow[] };
        }
        logWorkerEventArgs("api", "error", "[dex-liquidity] Unexpected error loading dex_prices:", msg);
        throw err;
      }),
    tableProjection ? Promise.resolve({ results: [] as DexDeploymentOutcomeRow[] }) : db
      .prepare(
        `SELECT stablecoin_id, chain, contract_address, outcome, provider_set_json, reason,
              observed_pool_count, observed_at, waiver_owner, waiver_reason, waiver_expires_at
         FROM dex_deployment_outcomes
        WHERE 1 = 1${coinFilter}
        ORDER BY stablecoin_id, chain, contract_address`,
      )
      .bind(...coinBindings)
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
           AND status IN ('ok', 'degraded', 'error')
           AND COALESCE(CASE WHEN json_valid(metadata)
             THEN json_extract(metadata, '$.persistence.skippedReason') END, '') != 'liquidity-cadence-reuse'
         ORDER BY started_at DESC
         LIMIT 1`,
      )
      .first<DexLiquidityCronRow>()
      .then((value) => ({ kind: "ok" as const, value }))
      .catch((error) => {
        logWorkerEventArgs("api", "warn", "[dex-liquidity] Producer advisory read failed:", toErrorMessage(error));
        return { kind: "unavailable" as const, reason: "dex-advisory-read-failed" as const };
      }),
  ]);
  const latestCron = cronRead.kind === "ok" ? cronRead.value : null;
  const advisoryUnavailableReason = cronRead.kind === "unavailable" ? cronRead.reason : null;
  const advisoryUnavailableWarning = advisoryUnavailableReason
    ? '199 - "DEX producer advisory unavailable (dex-advisory-read-failed)"'
    : null;

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
  // A missing coin still carries the census selected in the same SQL snapshot.
  const selectedRows = result.results ?? [];
  const rows = selectedRows.filter((row) => row.stablecoin_id != null);
  const cacheControl = advisoryUnavailableReason ? CACHE_PROFILES.noStore : CACHE_PROFILES.custom;
  // Cohort freshness follows the newest published producer row, as before the
  // compact projections. Individual rows retain their own clocks and warnings.
  const datasetUpdatedAt = rows.length > 0 ? Math.max(...rows.map((row) => row.updated_at)) : null;
  const headers: Record<string, string> = datasetUpdatedAt != null
    ? addFreshnessHeaders(
        { "Cache-Control": cacheControl },
        datasetUpdatedAt,
        API_FRESHNESS_MAX_AGE_SEC.dexLiquidity,
      )
    : stablecoinId ? { "Cache-Control": CACHE_PROFILES.noStore } : buildCronFreshnessHeaders(
        await getLatestSuccessfulCronTimestampResult(db, "sync-dex-liquidity"),
        API_FRESHNESS_MAX_AGE_SEC.dexLiquidity,
        cacheControl,
      );
  if (tableProjection) {
    const table: DexLiquidityTableMap = {};
    for (const row of rows) {
      let unavailableReason: "invalid-coverage-evidence" | null = null;
      try { normalizeDexLiquidityEvidence(row); } catch { unavailableReason = "invalid-coverage-evidence"; }
      table[row.stablecoin_id] = {
        liquidityScore: unavailableReason ? null : row.liquidity_score,
        warning: [addFreshnessHeaders({}, row.updated_at, API_FRESHNESS_MAX_AGE_SEC.dexLiquidity).Warning, advisoryUnavailableWarning, buildDexLiquidityWarning(latestCron,
          row.stablecoin_id === "__global__" ? { scope: "global" } : { scope: "coin", stablecoinId: row.stablecoin_id },
        )].filter(Boolean).join(", ") || null,
        unavailableReason,
        advisoryUnavailableReason,
        updatedAt: row.updated_at,
        methodologyVersion: row.methodology_version,
      };
    }
    const warning = advisoryUnavailableWarning ?? buildDexLiquidityWarning(latestCron, { scope: "global" });
    if (warning) headers.Warning = [headers.Warning, warning].filter(Boolean).join(", ");
    return jsonResponseWithHeaders(table, headers);
  }

  // Normalizers intentionally retain raw diagnostic fields until wire-schema admission.
  const map: Record<string, unknown> = {};
  let coinUnavailableReason: "invalid-coverage-evidence" | null = null;
  for (const row of rows) {
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

    // Prices are a separate publication; liquidity's clock cannot admit them.
    const priceRow = dexPriceById.get(id);
    const priceMaxAgeSec = STAGED_POOL_PRICE_MAX_AGE_HOURS * 3600;
    const priceAge = assessFreshnessTimestamp(nowSec, priceRow?.updated_at);
    // Both writers stamp the orchestrator's syncStartSec; any drift is publication-mismatch.
    const priceUnavailableReason = !priceRow ? "missing-price"
      : priceAge.reason != null ? priceAge.reason
      : priceAge.ageSeconds > priceMaxAgeSec ? "stale-price"
      : priceRow.updated_at !== row.updated_at ? "publication-mismatch" : null;
    const dexPrice = priceUnavailableReason == null ? priceRow : undefined;
    let evidence: NormalizedDexLiquidityEvidence | null = null;
    try {
      evidence = normalizeDexLiquidityEvidence(row);
    } catch (error) {
      logWorkerEventArgs("api", "error", `[dex-liquidity] Quarantining malformed evidence row for ${id}:`, error);
    }
    if (id === stablecoinId) coinUnavailableReason = evidence == null ? "invalid-coverage-evidence" : null;
    const scoreDetails = normalizeDexScoreDetails(
      row.score_components_json,
      `dex-liquidity:${id}:score_components_json`,
    );

    const normalizedTopPools = normalizeTopPools(row.top_pools_json, `dex-liquidity:${id}:top_pools_json`);
    const parseOk = normalizedTopPools !== null;
    const topPools = normalizedTopPools ?? [];
    const inferred7dMeasured =
      parseOk && (
        topPools.length === 0 ||
        topPools.every((pool) => typeof pool.volumeUsd7d === "number" && Number.isFinite(pool.volumeUsd7d))
      );
    const totalVolume7dMeasured = row.total_volume_7d_measured != null
      ? row.total_volume_7d_measured === 1
      : inferred7dMeasured;
    // DEC-19 availability record (migration 0249). Legacy rows keep today's
    // numbers with unrecorded completeness; recorded non-complete windows
    // publish no measured total.
    const volumeRecord = parseDexVolumeAvailabilityRecord(row.volume_availability_json);
    const volume24h = readStoredDexVolumeWindow(row.total_volume_24h_usd, volumeRecord, "24h");
    const volume7d = readStoredDexVolumeWindow(row.total_volume_7d_usd, volumeRecord, "7d", totalVolume7dMeasured);

    map[id] = {
      unavailableReason: evidence == null ? "invalid-coverage-evidence" : null,
      advisoryUnavailableReason,
      warning: [addFreshnessHeaders({}, row.updated_at, API_FRESHNESS_MAX_AGE_SEC.dexLiquidity).Warning, advisoryUnavailableWarning, buildDexLiquidityWarning(
        latestCron,
        id === "__global__" ? { scope: "global" } : { scope: "coin", stablecoinId: id },
      )]
        .filter(Boolean).join(", ") || null,
      totalTvlUsd: currentTvl,
      totalVolume24hUsd: volume24h.measuredUsd,
      totalVolume7dUsd: volume7d.measuredUsd,
      ...(volume24h.availability ? { volume24hAvailability: volume24h.availability } : {}),
      ...(volume7d.availability ? { volume7dAvailability: volume7d.availability } : {}),
      poolCount: row.pool_count,
      pairCount: row.pair_count,
      chainCount: row.chain_count,
      protocolTvl: safeJsonParse<Record<string, number>>(
        row.protocol_tvl_json,
        {},
        `dex-liquidity:${id}:protocol_tvl_json`,
      ),
      chainTvl: safeJsonParse<Record<string, number>>(row.chain_tvl_json, {}, `dex-liquidity:${id}:chain_tvl_json`),
      topPools,
      liquidityScore: evidence == null ? null : row.liquidity_score,
      concentrationHhi: row.concentration_hhi,
      depthStability: row.depth_stability,
      tvlChange24h: evidence != null && tvlChange24h != null ? Math.round(tvlChange24h * 100) / 100 : null,
      tvlChange7d: evidence != null && tvlChange7d != null ? Math.round(tvlChange7d * 100) / 100 : null,
      updatedAt: row.updated_at,
      dexPriceUpdatedAt: priceRow && Number.isFinite(priceRow.updated_at) && priceRow.updated_at >= 0
        ? priceRow.updated_at : null,
      dexPriceAgeSeconds: priceAge.ageSeconds,
      dexPriceMaxAgeSec: priceMaxAgeSec,
      dexPriceUnavailableReason: priceUnavailableReason,
      dexPriceUsd: dexPrice?.dex_price_usd ?? null,
      dexDeviationBps: dexPrice?.deviation_from_primary_bps ?? null,
      priceSourceCount: dexPrice?.source_pool_count ?? null,
      priceSourceTvl: dexPrice?.source_total_tvl ?? null,
      priceSources: safeJsonParse<DexLiquidityData["priceSources"]>(
        dexPrice?.price_sources_json,
        null,
        `dex-liquidity:${id}:price_sources_json`,
      ),
      // v2 fields
      effectiveTvlUsd: evidence?.effectiveTvlUsd ?? row.effective_tvl_usd ?? 0,
      avgPoolStress: row.avg_pool_stress ?? null,
      weightedBalanceRatio: row.weighted_balance_ratio ?? null,
      organicFraction: row.organic_fraction ?? null,
      durabilityScore: row.durability_score ?? null,
      coverageClass: evidence?.coverageClass ?? null,
      coverageConfidence: evidence?.coverageConfidence ?? null,
      liquidityEvidenceClass: evidence?.liquidityEvidenceClass ?? null,
      hasMeasuredLiquidityEvidence: evidence?.hasMeasuredLiquidityEvidence ?? false,
      trendworthy: evidence?.trendworthy ?? false,
      sourceMix: safeJsonParse<Record<string, { poolCount: number; tvlUsd: number }>>(
        row.source_mix_json,
        {},
        `dex-liquidity:${id}:source_mix_json`,
      ),
      balanceMeasuredTvlUsd: evidence?.balanceMeasuredTvlUsd ?? row.balance_measured_tvl_usd ?? 0,
      organicMeasuredTvlUsd: evidence?.organicMeasuredTvlUsd ?? row.organic_measured_tvl_usd ?? 0,
      scoreComponents: evidence == null ? null : scoreDetails.scoreComponents,
      lockedLiquidityPct: row.locked_liquidity_pct ?? null,
      methodologyVersion: row.methodology_version,
      deploymentCoverage: deploymentCoverageById.get(id) ?? null,
      exitRouteObservations: evidence == null ? null : scoreDetails.exitRouteObservations,
      ...(evidence == null ? {} : { exitRouteObservationCoverage: scoreDetails.exitRouteObservationCoverage }),
    };
  }

  const degradedWarning = advisoryUnavailableWarning ?? buildDexLiquidityWarning(latestCron, { scope: "global" });
  if (degradedWarning) {
    headers.Warning = headers.Warning ? `${headers.Warning}, ${degradedWarning}` : degradedWarning;
  }

  return jsonResponseWithHeaders(stablecoinId ? {
    coins: map,
    projection: {
      stablecoinId,
      generationId: rows[0]?.publication_generation_id ?? null,
      updatedAt: rows[0]?.updated_at ?? null,
      totalCount: selectedRows[0]?.projection_total_count ?? 0,
      unavailableReason: rows.length === 0 ? "row-not-published" : coinUnavailableReason,
    },
  } : map, headers);
};

export async function handleDexLiquidityCoin(db: D1Database, url: URL): Promise<Response> {
  const id = readCoinProjectionId(url);
  return id instanceof Response ? id : handleDexLiquidity(db, id);
}

export async function handleDexLiquidityTable(db: D1Database): Promise<Response> {
  return handleDexLiquidity(db, undefined, true);
}
