// worker/src/cron/sync-yield-data.ts
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import { YIELD_BEARING_STABLECOINS } from "@shared/lib/tracked-stablecoin-utils";
import { setCache, batchExecute, buildInClause } from "../lib/db";
import {
  PYS_SCALING_FACTOR,
  DEFAULT_SAFETY_SCORE,
} from "../lib/constants";
import {
  STALE_THRESHOLD_MS,
  computePYS,
  computeYieldStability,
  computeApyVarianceScore,
  detectWarningSignals,
} from "./yield-helpers";
import { LENDING_PROTOCOL_LABELS } from "./yield-config";
import { YieldRankingsResponseSchema, type AltYieldSource } from "@shared/types";
import type { CronResult } from "../lib/db";
import { validatePayloadWithSchema } from "../lib/api-utils";
import { computeSafetyScoresSnapshot } from "../lib/safety-scores";
import {
  fetchOnChainRates,
  loadDlStablecoinPools,
  loadRiskFreeRate,
} from "./yield-sync/sources";
import { resolveYieldSources } from "./yield-sync/resolve";
import {
  computeTvlWeightedMedianApy,
  dedupeLatestBestRows,
  rowToRanking,
} from "./yield-sync/rankings";

const MIN_SAFETY_SCORE_COVERAGE_RATIO = 0.5;
const TRACKED_META_BY_ID = new Map(
  TRACKED_STABLECOINS.map((stablecoin) => [stablecoin.id, stablecoin]),
);
// -- Main sync function ------------------------------------------------------

export async function syncYieldData(db: D1Database, signal?: AbortSignal): Promise<CronResult> {
  const startSec = Math.floor(Date.now() / 1000);
  const sevenDaysAgoSec = startSec - 7 * 86400;
  const yieldCoins = YIELD_BEARING_STABLECOINS;

  if (yieldCoins.length === 0) {
    return { itemCount: 0, metadata: "no yield-bearing coins" };
  }

  const dlPools = await loadDlStablecoinPools(db, signal);

  // 2. Fetch on-chain rates (Tier 1 source)
  const onChainRates = await fetchOnChainRates(signal);

  // 3. Read cached risk-free rate
  const riskFreeRate = await loadRiskFreeRate(db);

  // 4. Compute safety scores inline (report-cards API does NOT cache results)
  //    Follows the same two-phase approach as daily-digest.ts
  const safetySnapshot = await computeSafetyScoresSnapshot(db, {
    includeNavTokens: true,
    outputMode: "map",
  });
  const safetyScores = safetySnapshot.scores;
  const safetyCoverageRatio = safetySnapshot.coverageRatio;
  const safetySnapshotDegraded =
    safetySnapshot.kind !== "ok" || safetyCoverageRatio < MIN_SAFETY_SCORE_COVERAGE_RATIO;

  if (safetySnapshotDegraded) {
    console.warn(
      `[sync-yield-data] Safety snapshot coverage degraded: ${safetySnapshot.coveredCount}/${safetySnapshot.trackedCount} ` +
      `(${(safetyCoverageRatio * 100).toFixed(1)}%)${safetySnapshot.reason ? ` reason=${safetySnapshot.reason}` : ""}`,
    );
  }

  // Cache safety scores for other consumers (flow API, digest, etc.)
  const scoresObj: Record<string, { score: number; grade: string }> = {};
  for (const [id, val] of safetyScores) {
    scoresObj[id] = val;
  }
  if (!safetySnapshotDegraded) {
    await setCache(
      db,
      "report_card_cache",
      JSON.stringify({
        scores: scoresObj,
        updatedAt: startSec,
      }),
    );
  } else {
    console.warn("[sync-yield-data] Skipped report_card_cache write due to degraded safety snapshot");
  }

  const { resolved, tier1PrevRates } = await resolveYieldSources({
    db,
    startSec,
    sevenDaysAgoSec,
    dlPools,
    onChainRates,
    safetyScores,
    signal,
  });

  // 5c. Determine is_best per coin: source with highest currentApy wins
  const bestSourceKeyByCoin = new Map<string, string>();
  {
    const coinBestApy = new Map<string, number>();
    for (const { id, yield: y } of resolved) {
      if (!y) continue;
      const prev = coinBestApy.get(id) ?? -Infinity;
      if (y.currentApy > prev) {
        coinBestApy.set(id, y.currentApy);
        bestSourceKeyByCoin.set(id, y.sourceKey);
      }
    }
  }

  // 6. Compute trailing averages, PYS, and store
  const yieldDataStmts: D1PreparedStatement[] = [];
  const historyStmts: D1PreparedStatement[] = [];
  const historyWrittenForCoin = new Set<string>(); // only write history for the best source
  let updatedCount = 0;

  // Compute median APY across all resolved yield-bearing coins (for warning signals)
  const resolvedApys = resolved
    .filter((r) => r.yield != null)
    .map((r) => r.yield!.currentApy)
    .sort((a, b) => a - b);
  const medianApy =
    resolvedApys.length > 0
      ? resolvedApys.length % 2 === 1
        ? resolvedApys[Math.floor(resolvedApys.length / 2)]
        : (resolvedApys[resolvedApys.length / 2 - 1] + resolvedApys[resolvedApys.length / 2]) / 2
      : 0;

  const resolvedIds = [...new Set(resolved.filter((entry) => entry.yield != null).map((entry) => entry.id))];
  const historyById = new Map<string, Array<{ apy: number; recorded_at: number; source_tvl_usd: number | null }>>();
  const prevTvlMap = new Map<string, number | null>();
  if (resolvedIds.length > 0) {
    const resolvedIdInClause = buildInClause(resolvedIds);
    const [historyRows, prevTvlRows] = await Promise.all([
      db
        .prepare(
          `SELECT stablecoin_id, apy, recorded_at, source_tvl_usd
         FROM yield_history
         WHERE stablecoin_id IN (${resolvedIdInClause.sql}) AND recorded_at >= ?
         ORDER BY stablecoin_id ASC, recorded_at ASC`,
        )
        .bind(...resolvedIdInClause.binds, startSec - 30 * 86400)
        .all<{
          stablecoin_id: string;
          apy: number;
          recorded_at: number;
          source_tvl_usd: number | null;
        }>(),
      db
        .prepare(
          `SELECT stablecoin_id, source_tvl_usd, recorded_at
         FROM yield_history
         WHERE stablecoin_id IN (${resolvedIdInClause.sql}) AND recorded_at <= ? AND source_tvl_usd IS NOT NULL
         ORDER BY stablecoin_id ASC, recorded_at DESC`,
        )
        .bind(...resolvedIdInClause.binds, sevenDaysAgoSec)
        .all<{
          stablecoin_id: string;
          source_tvl_usd: number | null;
          recorded_at: number;
        }>(),
    ]);
    for (const row of historyRows.results ?? []) {
      const list = historyById.get(row.stablecoin_id) ?? [];
      list.push({ apy: row.apy, recorded_at: row.recorded_at, source_tvl_usd: row.source_tvl_usd });
      historyById.set(row.stablecoin_id, list);
    }
    for (const row of prevTvlRows.results ?? []) {
      if (!prevTvlMap.has(row.stablecoin_id)) {
        prevTvlMap.set(row.stablecoin_id, row.source_tvl_usd ?? null);
      }
    }
  }

  for (const { id, symbol, yield: y } of resolved) {
    if (!y) continue;

    const meta = TRACKED_META_BY_ID.get(id)!;
    const yieldConfig = meta.yieldConfig;
    // Variant wrapper rows carry their own yieldSource/yieldType overrides
    const yieldSource =
      y.yieldSource ??
      yieldConfig?.yieldSource ??
      (y.dataSource === "defillama-auto" && y.project
        ? (LENDING_PROTOCOL_LABELS[y.project] ?? y.project.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()))
        : "Unknown");
    const yieldType =
      y.yieldType ??
      yieldConfig?.yieldType ??
      (y.dataSource === "defillama-auto" ? "lending-opportunity" : "nav-appreciation");

    // is_best: 1 for the source with highest currentApy per coin, 0 for alternatives
    const isBest = bestSourceKeyByCoin.get(id) === y.sourceKey ? 1 : 0;

    // Load historical APY samples for trailing averages
    const histRows = historyById.get(id) ?? [];
    const samples = histRows.map((row) => row.apy);
    samples.push(y.currentApy);

    const apy7dSamples = histRows.filter((row) => row.recorded_at >= sevenDaysAgoSec).map((row) => row.apy);
    apy7dSamples.push(y.currentApy);
    const apy7d = apy7dSamples.reduce((s, v) => s + v, 0) / apy7dSamples.length;
    const apy30d = samples.reduce((s, v) => s + v, 0) / samples.length;

    const apyVarianceScore = computeApyVarianceScore(samples);
    const yieldStability = computeYieldStability(samples);
    const stdDev30d =
      samples.length >= 2 ? Math.sqrt(samples.reduce((s, v) => s + (v - apy30d) ** 2, 0) / samples.length) : null;
    const apyMin30d = samples.length > 0 ? samples.reduce((m, v) => Math.min(m, v), Infinity) : null;
    const apyMax30d = samples.length > 0 ? samples.reduce((m, v) => Math.max(m, v), -Infinity) : null;

    // Safety score
    const safety = safetyScores.get(id);
    const safetyScore = safety?.score ?? DEFAULT_SAFETY_SCORE;
    const safetyGrade = safety?.grade ?? "NR";

    // PYS
    const pys = computePYS({ apy30d, safetyScore, apyVarianceScore, scalingFactor: PYS_SCALING_FACTOR });
    const yieldToRisk = 101 - safetyScore > 0 ? apy30d / (101 - safetyScore) : null;
    const excessYield = apy30d - riskFreeRate;

    // Belt-and-suspenders: guard against NaN/Infinity reaching D1
    const safePys = Number.isFinite(pys) ? pys : 0;
    const safeVariance30d = stdDev30d != null && Number.isFinite(stdDev30d) ? stdDev30d : null;
    const safeStability = yieldStability != null && Number.isFinite(yieldStability) ? yieldStability : null;

    // Previous exchange rate (for Tier 1 coins — cached from resolution phase)
    const prevExchangeRate = tier1PrevRates.get(id) ?? null;

    // Warning signals
    const prevTvlUsd = prevTvlMap.get(id) ?? null;
    const warnings = detectWarningSignals({
      currentApy: y.currentApy,
      apy30d,
      apyReward: y.apyReward,
      medianApy,
      sourceTvlUsd: y.sourceTvlUsd,
      prevTvlUsd,
    });
    const warningSignalsJson = warnings.length > 0 ? JSON.stringify(warnings) : null;

    // Upsert yield_data
    yieldDataStmts.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO yield_data (
          stablecoin_id, source_key, symbol, current_apy, apy_base, apy_reward, apy_7d, apy_30d,
          yield_source, yield_type, source_pool, source_tvl_usd, data_source,
          safety_score, safety_grade, pharos_yield_score, yield_to_risk, excess_yield, yield_stability,
          apy_variance_30d, /* note: column stores standard deviation, not variance */
          apy_min_30d, apy_max_30d, exchange_rate, exchange_rate_prev, warning_signals, is_best, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          y.sourceKey,
          symbol,
          y.currentApy,
          y.apyBase,
          y.apyReward,
          apy7d,
          apy30d,
          yieldSource,
          yieldType,
          y.sourcePool,
          y.sourceTvlUsd,
          y.dataSource,
          safetyScore,
          safetyGrade,
          safePys,
          yieldToRisk,
          excessYield,
          safeStability,
          safeVariance30d,
          apyMin30d,
          apyMax30d,
          y.exchangeRate,
          prevExchangeRate,
          warningSignalsJson,
          isBest,
          startSec,
        ),
    );

    // Insert yield_history point (only for the best source per coin)
    if (isBest === 1 && !historyWrittenForCoin.has(id)) {
      historyStmts.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO yield_history (stablecoin_id, recorded_at, apy, apy_base, apy_reward, exchange_rate, source_tvl_usd, data_source, warning_signals)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            id,
            startSec,
            y.currentApy,
            y.apyBase,
            y.apyReward,
            y.exchangeRate,
            y.sourceTvlUsd,
            y.dataSource,
            warningSignalsJson,
          ),
      );
      historyWrittenForCoin.add(id);
    }

    updatedCount++;
  }

  // Cross-source APY validation: flag >50% divergence between native and lending
  {
    const nativeApyByCoin = new Map<string, number>();
    const lendingApyByCoin = new Map<string, number>();
    for (const r of resolved) {
      if (!r.yield) continue;
      const ds = r.yield.dataSource;
      if (ds === "defillama" || ds === "onchain" || ds === "price-derived") {
        nativeApyByCoin.set(r.id, r.yield.currentApy);
      } else if (ds === "defillama-auto") {
        lendingApyByCoin.set(r.id, r.yield.currentApy);
      }
    }
    for (const [coinId, nativeApy] of nativeApyByCoin) {
      const lendingApy = lendingApyByCoin.get(coinId);
      if (lendingApy != null && nativeApy > 0 && lendingApy > 0) {
        const maxApy = Math.max(nativeApy, lendingApy);
        if (Math.abs(nativeApy - lendingApy) / maxApy > 0.5) {
          console.warn(
            `[yield-sync] APY divergence for ${coinId}: native=${nativeApy.toFixed(1)}% vs lending=${lendingApy.toFixed(1)}%`,
          );
        }
      }
    }
  }

  // 7. Batch write
  const writeStmts = [...yieldDataStmts, ...historyStmts];
  if (writeStmts.length > 0) await batchExecute(db, writeStmts);

  // 7b. Purge stale rows for coins refreshed in this run so old primary sources
  // cannot linger beside the new winner when a coin's best source changes.
  if (resolvedIds.length > 0) {
    const staleRowInClause = buildInClause(resolvedIds);
    await db
      .prepare(
        `DELETE FROM yield_data
       WHERE stablecoin_id IN (${staleRowInClause.sql}) AND updated_at < ?`,
      )
      .bind(...staleRowInClause.binds, startSec)
      .run();
  }

  // 8. Prune old history (>365 days)
  const pruneCutoff = startSec - 365 * 86400;
  await db.prepare("DELETE FROM yield_history WHERE recorded_at < ?").bind(pruneCutoff).run();

  // 9. Cache the rankings response for fast API reads
  const rankingsData = await db
    .prepare("SELECT * FROM yield_data WHERE is_best = 1 ORDER BY pharos_yield_score DESC")
    .all();

  // Fetch alt sources for coins with multiple yield sources
  const altSourcesData = await db
    .prepare(
      "SELECT stablecoin_id, source_key, current_apy, apy_30d, yield_source, yield_type, source_tvl_usd, data_source FROM yield_data WHERE is_best = 0",
    )
    .all<{
      stablecoin_id: string;
      source_key: string;
      current_apy: number;
      apy_30d: number;
      yield_source: string;
      yield_type: string;
      source_tvl_usd: number | null;
      data_source: string;
    }>();
  const altSourcesByCoin = new Map<string, AltYieldSource[]>();
  for (const row of altSourcesData.results ?? []) {
    const alts = altSourcesByCoin.get(row.stablecoin_id) ?? [];
    alts.push({
      sourceKey: row.source_key,
      yieldSource: row.yield_source,
      yieldType: row.yield_type as AltYieldSource["yieldType"],
      currentApy: row.current_apy,
      apy30d: row.apy_30d,
      sourceTvlUsd: row.source_tvl_usd,
      dataSource: row.data_source,
    });
    altSourcesByCoin.set(row.stablecoin_id, alts);
  }

  const now = Date.now();
  const tvlWeightedMedian = computeTvlWeightedMedianApy(
    (rankingsData.results ?? []) as Array<{ apy_30d: number; source_tvl_usd: number | null }>,
  );
  const rankingsPayload = {
    rankings: dedupeLatestBestRows(rankingsData.results ?? []).map((row) => {
      const ranking = {
        ...rowToRanking(row),
        altSources: altSourcesByCoin.get(row.stablecoin_id as string) ?? [],
      };
      // Decorate with data-stale signal at read time (not persisted to yield_data).
      const updatedAtMs = typeof row.updated_at === "number" ? row.updated_at * 1000 : 0;
      if (updatedAtMs > 0 && updatedAtMs < now - STALE_THRESHOLD_MS) {
        if (!ranking.warningSignals.includes("data-stale")) {
          ranking.warningSignals = [...ranking.warningSignals, "data-stale"];
        }
      }
      return ranking;
    }),
    riskFreeRate,
    scalingFactor: PYS_SCALING_FACTOR,
    medianApy: tvlWeightedMedian,
    updatedAt: startSec,
  };
  const validation = validatePayloadWithSchema(
    YieldRankingsResponseSchema,
    rankingsPayload,
    "sync-yield-data:yield-rankings",
  );
  const degradationReasons: string[] = [];
  if (safetySnapshotDegraded) {
    degradationReasons.push("safety-snapshot-coverage");
    if (safetySnapshot.reason) {
      degradationReasons.push(`safety-snapshot:${safetySnapshot.reason}`);
    }
  }

  let validationFailures = 0;
  if (validation.ok && !safetySnapshotDegraded) {
    await setCache(db, "yield-rankings", JSON.stringify(validation.data));
  } else if (!validation.ok) {
    validationFailures++;
    degradationReasons.push("schema-validation-failed");
    console.warn("[sync-yield-data] Skipped yield-rankings cache write due to schema validation failure");
  } else {
    console.warn("[sync-yield-data] Skipped yield-rankings cache write due to degraded safety snapshot");
  }

  console.log(`[sync-yield-data] Updated ${updatedCount} coins (${yieldCoins.length} yield-bearing + auto-discovered)`);
  const status = degradationReasons.length > 0 ? "degraded" : "ok";
  return {
    itemCount: updatedCount,
    ...(status === "degraded" ? { status: "degraded" as const } : {}),
    metadata: JSON.stringify({
      rowsRead: yieldCoins.length,
      rowsWritten: updatedCount,
      rowsDropped: 0,
      sourceCoverage: {
        safetyScoresComputed: safetySnapshot.coveredCount,
        safetyScoresExpected: safetySnapshot.trackedCount,
        safetyCoverageRatio: Number(safetyCoverageRatio.toFixed(4)),
      },
      fallbackMode: degradationReasons.length > 0 ? degradationReasons.join(",") : null,
      validationFailures,
      riskFreeRate,
      cacheWriteSkipped: !validation.ok || safetySnapshotDegraded,
    }),
  };
}
