// worker/src/cron/sync-yield-data.ts
import { YIELD_BEARING_STABLECOINS } from "@shared/lib/tracked-stablecoin-utils";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { setCache } from "../lib/db-cache";
import type { CronResult } from "../lib/cron-logger";
import { computeSafetyScoresSnapshot } from "../lib/safety-scores";
import { ON_CHAIN_RATE_CONFIGS } from "./yield-config";
import type { ChainRpcConfig } from "../lib/chain-registry";
import {
  fetchOnChainRates,
  loadDlStablecoinPools,
  loadRiskFreeRateSnapshot,
} from "./yield-sync/sources";
import { resolveYieldSources } from "./yield-sync/resolve";
import {
  loadYieldHistorySnapshots,
  type YieldHistorySnapshotRow,
} from "./yield-sync/history";
import {
  buildSelectionReason,
  evaluateYieldSources,
  buildHistoryKey,
  isLegacyDeterministicOnChainSourceKey,
  normalizePreviousBestSourceKey,
  shouldDegradeForRiskFreeRate,
} from "./yield-sync/evaluation";
import {
  buildYieldRankingsPayloadFromEvaluatedSources,
  persistEvaluatedYieldSources,
  pruneYieldTables,
  validateYieldRankingsPayloadForPublish,
  writeYieldRankingsCache,
} from "./yield-sync/publication";

const MIN_SAFETY_SCORE_COVERAGE_RATIO = 0.75;
// -- Main sync function ------------------------------------------------------

export async function syncYieldData(
  db: D1Database,
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
  coingeckoApiKey?: string | null,
  etherscanApiKey?: string | null,
): Promise<CronResult> {
  const startSec = Math.floor(Date.now() / 1000);
  const sevenDaysAgoSec = startSec - 7 * DAY_SECONDS;
  const yieldCoins = YIELD_BEARING_STABLECOINS;

  if (yieldCoins.length === 0) {
    return { itemCount: 0, metadata: "no yield-bearing coins" };
  }

  const { pools: dlPools, meta: dlPoolsMeta } = await loadDlStablecoinPools(db, signal);
  const {
    rates: onChainRates,
    failureBreakdown: onChainFailures,
    attemptedCount: onChainAttemptedCount = 0,
    allDeterministicFailed = false,
  } = await fetchOnChainRates(signal, chainRpcs, etherscanApiKey);
  const riskFreeRateMeta = await loadRiskFreeRateSnapshot(db);
  const riskFreeRate = riskFreeRateMeta.rate;

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
    riskFreeRate,
    signal,
    chainRpcs,
    coingeckoApiKey,
  });

  const resolvedWithYield = resolved.filter((entry) => entry.yield != null);
  const resolvedIds = [...new Set(resolvedWithYield.map((entry) => entry.id))];
  const resolvedCountByCoin = new Map<string, number>();
  for (const entry of resolvedWithYield) {
    resolvedCountByCoin.set(entry.id, (resolvedCountByCoin.get(entry.id) ?? 0) + 1);
  }

  const sourceHistory = new Map<string, YieldHistorySnapshotRow[]>();
  const onChainCompatibilityHistoryById = new Map<string, YieldHistorySnapshotRow[]>();
  const legacyDeterministicOnChainHistoryById = new Map<string, YieldHistorySnapshotRow[]>();
  const legacyHistoryById = new Map<string, YieldHistorySnapshotRow[]>();
  const prevTvlBySource = new Map<string, number | null>();
  const legacyPrevTvlById = new Map<string, number | null>();
  const prevBestSourceKeyByCoin = new Map<string, string>();

  if (resolvedIds.length > 0) {
    const {
      historyRows,
      prevTvlRows,
      prevBestRows,
    } = await loadYieldHistorySnapshots(db, resolvedIds, startSec, sevenDaysAgoSec);

    for (const row of historyRows) {
      const sourceKey = row.source_key ?? "legacy-best";
      const normalizedRow = { ...row, source_key: sourceKey };
      if (sourceKey === "legacy-best") {
        const list = legacyHistoryById.get(row.stablecoin_id) ?? [];
        list.push(normalizedRow);
        legacyHistoryById.set(row.stablecoin_id, list);
      } else {
        const key = buildHistoryKey(row.stablecoin_id, sourceKey);
        const list = sourceHistory.get(key) ?? [];
        list.push(normalizedRow);
        sourceHistory.set(key, list);
      }

      if (row.data_source === "onchain" && row.exchange_rate != null) {
        const list = onChainCompatibilityHistoryById.get(row.stablecoin_id) ?? [];
        list.push(normalizedRow);
        onChainCompatibilityHistoryById.set(row.stablecoin_id, list);
      }

      if (isLegacyDeterministicOnChainSourceKey(row.stablecoin_id, sourceKey)) {
        const list = legacyDeterministicOnChainHistoryById.get(row.stablecoin_id) ?? [];
        list.push(normalizedRow);
        legacyDeterministicOnChainHistoryById.set(row.stablecoin_id, list);
      }
    }

    for (const row of prevTvlRows) {
      const sourceKey = row.source_key ?? "legacy-best";
      if (sourceKey === "legacy-best") {
        if (!legacyPrevTvlById.has(row.stablecoin_id)) {
          legacyPrevTvlById.set(row.stablecoin_id, row.source_tvl_usd ?? null);
        }
      } else {
        const key = buildHistoryKey(row.stablecoin_id, sourceKey);
        if (!prevTvlBySource.has(key)) {
          prevTvlBySource.set(key, row.source_tvl_usd ?? null);
        }
      }
    }

    for (const row of prevBestRows) {
      if (!prevBestSourceKeyByCoin.has(row.stablecoin_id)) {
        prevBestSourceKeyByCoin.set(
          row.stablecoin_id,
          normalizePreviousBestSourceKey(row),
        );
      }
    }
  }

  const {
    evaluatedSources,
    bestSourceKeyByCoin,
    defaultSafetyIds,
    rowsRejected,
    divergenceFlags,
    sourceSwitches,
    medianApy,
  } = evaluateYieldSources({
    resolved: resolvedWithYield,
    startSec,
    sevenDaysAgoSec,
    safetyScores,
    riskFreeRate,
    tier1PrevRates,
    sourceHistory,
    onChainCompatibilityHistoryById,
    legacyDeterministicOnChainHistoryById,
    legacyHistoryById,
    prevTvlBySource,
    legacyPrevTvlById,
    prevBestSourceKeyByCoin,
  });

  {
    const nativeApyByCoin = new Map<string, number>();
    const lendingApyByCoin = new Map<string, number>();
    for (const source of evaluatedSources) {
      if (source.dataSource === "defillama-auto") {
        lendingApyByCoin.set(source.id, source.currentApy);
      } else {
        nativeApyByCoin.set(source.id, source.currentApy);
      }
    }
    for (const [coinId, nativeApy] of nativeApyByCoin) {
      const lendingApy = lendingApyByCoin.get(coinId);
      if (lendingApy != null && nativeApy > 0 && lendingApy > 0) {
        const divergence = Math.abs(nativeApy - lendingApy) / Math.max(Math.abs(nativeApy), Math.abs(lendingApy), 1e-9);
        if (divergence > 0.35) {
          console.warn(
            `[yield-sync] APY divergence for ${coinId}: native=${nativeApy.toFixed(1)}% vs lending=${lendingApy.toFixed(1)}%`,
          );
        }
      }
    }
  }

  // Coverage regression guard: skip persistence if yield coverage drops below 60%
  // Only applies when there are enough tracked coins to make the ratio meaningful.
  const MIN_YIELD_COVERAGE_RATIO = 0.6;
  const MIN_YIELD_COINS_FOR_GUARD = 10;
  const yieldCoverageRatio = yieldCoins.length > 0 ? resolvedIds.length / yieldCoins.length : 1;
  if (yieldCoins.length >= MIN_YIELD_COINS_FOR_GUARD && yieldCoverageRatio < MIN_YIELD_COVERAGE_RATIO) {
    console.error(
      `[sync-yield-data] Yield coverage regression: ${resolvedIds.length}/${yieldCoins.length} ` +
      `(${(yieldCoverageRatio * 100).toFixed(1)}%) — skipping persistence`,
    );
    return {
      status: "degraded" as const,
      itemCount: resolvedIds.length,
      metadata: JSON.stringify({
        reason: "coverage-regression",
        coverage: yieldCoverageRatio,
        resolvedCount: resolvedIds.length,
        totalCount: yieldCoins.length,
      }),
    };
  }

  const safetySnapshotMeta = {
    kind: safetySnapshot.kind,
    coverageRatio: Number(safetyCoverageRatio.toFixed(4)),
    coveredCount: safetySnapshot.coveredCount,
    trackedCount: safetySnapshot.trackedCount,
    reason: safetySnapshot.reason ?? null,
  } as const;

  const previewRankingProvenanceByKey = new Map<string, Record<string, unknown>>();
  for (const source of evaluatedSources) {
    const sourceObservedAt =
      source.sourceObservedAt
      ?? (source.dataSource === "defillama" || source.dataSource === "defillama-auto"
        ? (dlPoolsMeta.updatedAt ?? startSec)
        : source.dataSource === "rate-derived"
          ? (riskFreeRateMeta.fetchedAt ?? startSec)
          : startSec);
    const sourceAgeSeconds =
      source.dataSource === "defillama" || source.dataSource === "defillama-auto"
        ? (dlPoolsMeta.ageSeconds ?? Math.max(0, startSec - sourceObservedAt))
        : source.dataSource === "rate-derived"
          ? (riskFreeRateMeta.ageSeconds ?? Math.max(0, startSec - sourceObservedAt))
          : Math.max(0, startSec - sourceObservedAt);
    const comparisonAnchorObservedAt = source.comparisonAnchorObservedAt ?? null;
    const comparisonAnchorAgeSeconds =
      comparisonAnchorObservedAt != null
        ? Math.max(0, startSec - comparisonAnchorObservedAt)
        : null;
    const rejectedPeers = evaluatedSources.filter((candidate) => candidate.id === source.id && candidate.rejected).length;
    previewRankingProvenanceByKey.set(buildHistoryKey(source.id, source.sourceKey), {
      sourceKey: source.sourceKey,
      sourceObservedAt,
      sourceAgeSeconds,
      comparisonAnchorObservedAt,
      comparisonAnchorAgeSeconds,
      confidenceTier: source.confidenceTier,
      selectionMethod: "confidence-weighted",
      selectionReason:
        bestSourceKeyByCoin.get(source.id) === source.sourceKey
          ? buildSelectionReason(source, rejectedPeers)
          : "Alternative source retained for comparison",
      sourceSwitch:
        bestSourceKeyByCoin.get(source.id) === source.sourceKey &&
        source.previousBestSourceKey != null &&
        source.previousBestSourceKey !== "legacy-best" &&
        source.previousBestSourceKey !== source.sourceKey,
      previousBestSourceKey:
        source.previousBestSourceKey != null && source.previousBestSourceKey !== "legacy-best"
          ? source.previousBestSourceKey
          : null,
      usedLegacyHistory: source.usedLegacyHistory,
      usedDefaultSafety: source.usedDefaultSafety,
      benchmarkRecordDate: riskFreeRateMeta.recordDate,
      benchmarkIsFallback: riskFreeRateMeta.isFallback,
      benchmarkFallbackMode: riskFreeRateMeta.fallbackMode,
      anomalies: source.anomalies,
    });
  }

  const previewRankingsPayload = buildYieldRankingsPayloadFromEvaluatedSources({
    evaluatedSources,
    bestSourceKeyByCoin,
    rankingProvenanceByKey: previewRankingProvenanceByKey,
    riskFreeRate,
    riskFreeRateMeta,
    dlPoolsMeta,
    safetySnapshot: safetySnapshotMeta,
    startSec,
  });

  const degradationReasons: string[] = [];
  if (safetySnapshotDegraded) {
    degradationReasons.push("safety-snapshot-coverage");
    if (safetySnapshot.reason) {
      degradationReasons.push(`safety-snapshot:${safetySnapshot.reason}`);
    }
  }
  if (shouldDegradeForRiskFreeRate(riskFreeRateMeta)) {
    degradationReasons.push(`risk-free-rate:${riskFreeRateMeta.fallbackMode}`);
  }
  if (dlPoolsMeta.mode === "unavailable" || dlPoolsMeta.fallbackMode === "cache-parse-failed") {
    degradationReasons.push(`dl-pools:${dlPoolsMeta.fallbackMode ?? dlPoolsMeta.mode}`);
  }
  if (allDeterministicFailed) {
    degradationReasons.push("onchain-rates:all-deterministic-failed");
  }

  const previewPublishability = await validateYieldRankingsPayloadForPublish(db, previewRankingsPayload);
  if (!previewPublishability.ok) {
    degradationReasons.push(previewPublishability.reason ?? "schema-validation-failed");
    return {
      status: "degraded" as const,
      itemCount: resolvedIds.length,
      metadata: JSON.stringify({
        reason: "yield-rankings-preflight-failed",
        publishFailure: previewPublishability.reason ?? "schema-validation-failed",
        validationFailures: previewPublishability.validationFailures,
        rowsRejected,
        divergenceFlags,
        sourceSwitches,
      }),
    };
  }

  const {
    updatedCount,
  } = await persistEvaluatedYieldSources(db, {
    evaluatedSources,
    bestSourceKeyByCoin,
    startSec,
    medianApy,
    riskFreeRateMeta,
    dlPoolsMeta,
  });

  const cacheWrite = await writeYieldRankingsCache(db, previewRankingsPayload);
  if (!cacheWrite.ok) {
    degradationReasons.push(cacheWrite.reason ?? "schema-validation-failed");
  }
  const validationFailures = cacheWrite.validationFailures;

  const shouldRetainPreviousRows = degradationReasons.length > 0;
  await pruneYieldTables(db, startSec, {
    allowDestructiveCleanup: !shouldRetainPreviousRows,
  });

  console.log(`[sync-yield-data] Updated ${updatedCount} source rows (${yieldCoins.length} yield-bearing + auto-discovered)`);
  const status = degradationReasons.length > 0 ? "degraded" : "ok";
  return {
    itemCount: updatedCount,
    ...(status === "degraded" ? { status: "degraded" as const } : {}),
    metadata: JSON.stringify({
      rowsRead: yieldCoins.length,
      rowsWritten: updatedCount,
      rowsDropped: rowsRejected,
      rowsRejected,
      divergenceFlags,
      sourceSwitches,
      defaultSafetyCoinCount: defaultSafetyIds.size,
      sourceCoverage: {
        safetyScoresComputed: safetySnapshot.coveredCount,
        safetyScoresExpected: safetySnapshot.trackedCount,
        safetyCoverageRatio: Number(safetyCoverageRatio.toFixed(4)),
        dlPoolCount: dlPoolsMeta.poolCount,
        onChainRatesResolved: onChainRates.size,
        onChainRatesConfigured: ON_CHAIN_RATE_CONFIGS.length,
        onChainAttempted: onChainAttemptedCount,
        onChainAllDeterministicFailed: allDeterministicFailed,
        onChainFailures: onChainFailures,
      },
      fallbackMode: degradationReasons.length > 0 ? degradationReasons.join(",") : null,
      validationFailures,
      riskFreeRate,
      cacheWriteSkipped: !cacheWrite.ok,
    }),
  };
}
