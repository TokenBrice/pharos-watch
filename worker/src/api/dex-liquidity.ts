import {
  withErrorHandler,
  safeParse,
  addFreshnessHeaders,
  jsonResponse,
  getLatestSuccessfulCronTimestamp,
} from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import { getLiquidityMethodologyVersionAt } from "@shared/lib/liquidity-score-version";
import type { LiquidityPoolSourceFamily } from "@shared/types";

const TREND_BASELINE_CONFIDENCE_MIN = 0.5;
const TREND_24H_TOLERANCE_SEC = 12 * 3600;
const TREND_7D_TOLERANCE_SEC = 36 * 3600;

interface DexLiquidityRow {
  stablecoin_id: string;
  total_tvl_usd: number;
  total_volume_24h_usd: number;
  total_volume_7d_usd: number;
  pool_count: number;
  pair_count: number;
  chain_count: number;
  protocol_tvl_json: string | null;
  chain_tvl_json: string | null;
  top_pools_json: string | null;
  liquidity_score: number | null;
  concentration_hhi: number | null;
  depth_stability: number | null;
  updated_at: number;
  effective_tvl_usd: number | null;
  avg_pool_stress: number | null;
  weighted_balance_ratio: number | null;
  organic_fraction: number | null;
  durability_score: number | null;
  score_components_json: string | null;
  locked_liquidity_pct: number | null;
  coverage_class: string | null;
  coverage_confidence: number | null;
  source_mix_json: string | null;
  balance_measured_tvl_usd: number | null;
  organic_measured_tvl_usd: number | null;
  methodology_version: string | null;
}

interface DexHistoryRow {
  stablecoin_id: string;
  total_tvl_usd: number;
  snapshot_date: number;
  coverage_class: string | null;
  coverage_confidence: number | null;
}

interface DexPriceRow {
  stablecoin_id: string;
  dex_price_usd: number;
  deviation_from_primary_bps: number | null;
  source_pool_count: number;
  source_total_tvl: number;
  price_sources_json: string | null;
  updated_at: number;
}

interface DexLiquidityCronRow {
  status: string;
  metadata: string | null;
}

type DexLiquidityPoolResponse = {
  source?: string;
} & Record<string, unknown>;

function normalizePoolSource(source: unknown): LiquidityPoolSourceFamily | undefined {
  if (typeof source !== "string" || source.length === 0) return undefined;
  if (source === "cg") return "cg_onchain";
  if (source === "gt") return "gecko_terminal";
  if (source === "ds") return "dexscreener";
  if (
    source === "dl" ||
    source === "cg_onchain" ||
    source === "gecko_terminal" ||
    source === "dexscreener" ||
    source === "cg_tickers"
  ) {
    return source;
  }
  return undefined;
}

function normalizeTopPools(json: string | null): DexLiquidityPoolResponse[] {
  const parsed = safeParse<DexLiquidityPoolResponse[]>(json, []);
  return parsed.map((pool) => {
    const normalizedSource = normalizePoolSource(pool.source);
    return normalizedSource == null
      ? { ...pool, source: undefined }
      : { ...pool, source: normalizedSource };
  });
}

function selectTrendBaseline(
  history: DexHistoryRow[],
  targetSec: number,
  toleranceSec: number,
): DexHistoryRow | null {
  let best: DexHistoryRow | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const row of history) {
    const confidence = row.coverage_confidence ?? 0;
    if (confidence < TREND_BASELINE_CONFIDENCE_MIN) continue;
    if (row.total_tvl_usd <= 0) continue;

    const distance = Math.abs(row.snapshot_date - targetSec);
    if (distance > toleranceSec) continue;
    if (distance < bestDistance) {
      best = row;
      bestDistance = distance;
    }
  }

  return best;
}

function buildDexLiquidityWarning(latestCron: DexLiquidityCronRow | null): string | null {
  if (!latestCron) return null;
  if (latestCron.status !== "degraded" && latestCron.status !== "error") return null;

  let failedSources: string[] = [];
  let nearCoverageGuard = false;
  let nearValueGuard = false;
  let nearMajorCoverageGuard = false;
  if (latestCron.metadata) {
    try {
      const parsed = JSON.parse(latestCron.metadata) as {
        failedSources?: string[];
        sourceCoverage?: {
          nearCoverageGuard?: boolean;
          nearValueGuard?: boolean;
          nearMajorCoverageGuard?: boolean;
        };
      };
      failedSources = parsed.failedSources ?? [];
      nearCoverageGuard = parsed.sourceCoverage?.nearCoverageGuard ?? false;
      nearValueGuard = parsed.sourceCoverage?.nearValueGuard ?? false;
      nearMajorCoverageGuard = parsed.sourceCoverage?.nearMajorCoverageGuard ?? false;
    } catch {
      // Ignore malformed metadata and fall back to generic warning text.
    }
  }

  const details: string[] = [];
  if (failedSources.length > 0) details.push(`failedSources=${failedSources.join(",")}`);
  if (nearCoverageGuard) details.push("nearCoverageGuard");
  if (nearValueGuard) details.push("nearValueGuard");
  if (nearMajorCoverageGuard) details.push("nearMajorCoverageGuard");

  const suffix = details.length > 0 ? ` (${details.join("; ")})` : "";
  if (latestCron.status === "error") {
    return `199 - "Latest sync-dex-liquidity run failed; serving last successful dataset${suffix}"`;
  }
  return `199 - "Latest sync-dex-liquidity run degraded${suffix}"`;
}

export const handleDexLiquidity = withErrorHandler("dex-liquidity", async (db: D1Database): Promise<Response> => {
  const [result, histResult, priceResult, latestCron] = await Promise.all([
    db.prepare("SELECT * FROM dex_liquidity ORDER BY liquidity_score DESC").all<DexLiquidityRow>(),
    db
      .prepare(
        `SELECT stablecoin_id, total_tvl_usd, snapshot_date, coverage_class, coverage_confidence
         FROM dex_liquidity_history
         WHERE snapshot_date >= ?
         ORDER BY stablecoin_id, snapshot_date DESC`
      )
      .bind(Math.floor(Date.now() / 1000) - 8 * 86_400) // 8 days back covers 7d comparison
      .all<DexHistoryRow>(),
    db.prepare("SELECT * FROM dex_prices").all<DexPriceRow>().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("no such table")) {
        console.error("[dex-liquidity] Unexpected error loading dex_prices:", msg);
      }
      return { results: [] as DexPriceRow[] };
    }),
    db
      .prepare(
        `SELECT status, metadata
         FROM cron_runs
         WHERE job = 'sync-dex-liquidity'
         ORDER BY started_at DESC
         LIMIT 1`
      )
      .first<DexLiquidityCronRow>()
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
  const oneDayAgo = nowSec - 86_400;
  const sevenDaysAgo = nowSec - 7 * 86_400;

  const map: Record<string, unknown> = {};
  for (const row of result.results ?? []) {
    const id = row.stablecoin_id;
    const currentTvl = row.total_tvl_usd;

    // Compute trend changes from history
    const history = histByCoin.get(id) ?? [];
    const baseline24h = selectTrendBaseline(history, oneDayAgo, TREND_24H_TOLERANCE_SEC);
    const baseline7d = selectTrendBaseline(history, sevenDaysAgo, TREND_7D_TOLERANCE_SEC);
    const tvlChange24h = baseline24h ? ((currentTvl - baseline24h.total_tvl_usd) / baseline24h.total_tvl_usd) * 100 : null;
    const tvlChange7d = baseline7d ? ((currentTvl - baseline7d.total_tvl_usd) / baseline7d.total_tvl_usd) * 100 : null;

    // Merge DEX price data if available
    const dexPrice = dexPriceById.get(id);

    map[id] = {
      totalTvlUsd: currentTvl,
      totalVolume24hUsd: row.total_volume_24h_usd,
      totalVolume7dUsd: row.total_volume_7d_usd,
      poolCount: row.pool_count,
      pairCount: row.pair_count,
      chainCount: row.chain_count,
      protocolTvl: safeParse<Record<string, number>>(row.protocol_tvl_json, {}),
      chainTvl: safeParse<Record<string, number>>(row.chain_tvl_json, {}),
      topPools: normalizeTopPools(row.top_pools_json),
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
      priceSources: safeParse<unknown[] | null>(dexPrice?.price_sources_json, null),
      // v2 fields
      effectiveTvlUsd: row.effective_tvl_usd ?? 0,
      avgPoolStress: row.avg_pool_stress ?? null,
      weightedBalanceRatio: row.weighted_balance_ratio ?? null,
      organicFraction: row.organic_fraction ?? null,
      durabilityScore: row.durability_score ?? null,
      coverageClass: row.coverage_class ?? "legacy",
      coverageConfidence: row.coverage_confidence ?? 0.5,
      sourceMix: safeParse<Record<string, { poolCount: number; tvlUsd: number }>>(row.source_mix_json, {}),
      balanceMeasuredTvlUsd: row.balance_measured_tvl_usd ?? 0,
      organicMeasuredTvlUsd: row.organic_measured_tvl_usd ?? 0,
      scoreComponents: safeParse<unknown>(row.score_components_json, null),
      lockedLiquidityPct: row.locked_liquidity_pct ?? null,
      methodologyVersion: row.methodology_version ?? getLiquidityMethodologyVersionAt(row.updated_at),
    };
  }

  const rows = result.results ?? [];
  const latestRowUpdate = rows.length > 0
    ? rows.reduce((m, r) => Math.max(m, r.updated_at), 0)
    : Math.floor(Date.now() / 1000);
  const freshnessTs = await getLatestSuccessfulCronTimestamp(db, "sync-dex-liquidity", latestRowUpdate);

  const headers = addFreshnessHeaders({
    "Cache-Control": CACHE_PROFILES.standard,
  }, freshnessTs, 3600);
  const degradedWarning = buildDexLiquidityWarning(latestCron);
  if (degradedWarning) {
    headers.Warning = headers.Warning ? `${headers.Warning}, ${degradedWarning}` : degradedWarning;
  }

  return jsonResponse(map, headers);
});
