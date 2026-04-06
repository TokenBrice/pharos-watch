// worker/src/cron/sync-yield-data.ts
import { ACTIVE_YIELD_BEARING_STABLECOINS } from "@shared/lib/tracked-stablecoin-utils";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { setCache } from "../lib/db-cache";
import type { CronResult } from "../lib/cron-logger";
import { ON_CHAIN_RATE_CONFIGS } from "./yield-config";
import type { ChainRpcConfig } from "../lib/chain-registry";
import { toYieldBenchmarkRegistry } from "./yield-sync/benchmarks";
import { resolveYieldSources } from "./yield-sync/resolve";
import {
  loadYieldHistorySnapshots,
  type YieldHistorySnapshotRow,
} from "./yield-sync/history";
import {
  evaluateYieldSources,
  buildHistoryKey,
  isLegacyDeterministicOnChainSourceKey,
  normalizePreviousBestSourceKey,
} from "./yield-sync/evaluation";
import { buildYieldSourceProvenance } from "./yield-sync/provenance";
import {
  buildYieldDegradationReasons,
  buildYieldSafetySnapshotMeta,
  buildYieldSyncMetadata,
} from "./yield-sync/coordinator-metadata";
import {
  buildYieldRankingsPayloadFromEvaluatedSources,
  persistEvaluatedYieldSources,
  readPreviousYieldRankingsCount,
  pruneYieldTables,
  validateYieldRankingsPayloadForPublish,
  writeYieldRankingsCache,
} from "./yield-sync/publication";
import {
  buildNextDeterministicOnChainHealthState,
  loadYieldSyncState,
  persistDeterministicOnChainHealthState,
} from "./yield-sync/state-loading";
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
  const yieldCoins = ACTIVE_YIELD_BEARING_STABLECOINS;
  const yieldCoinIdSet = new Set(yieldCoins.map((coin) => coin.id));

  if (yieldCoins.length === 0) {
    return { itemCount: 0, metadata: "no yield-bearing coins" };
  }

  const {
    dlPools,
    dlPoolsMeta,
    supplementalCandidates,
    supplementalMeta,
    onChainHealthState,
    onChainCooldownActive,
    onChainCooldownRemainingSec,
    onChainSkippedDueToCooldown,
    onChainRates,
    onChainFailures,
    onChainAttemptedCount,
    allDeterministicFailed,
    onChainExplorerAttemptedCount,
    onChainExplorerResolvedCount,
    riskFreeRates,
    riskFreeRateMeta,
    stablecoinSupplyById,
    safetySnapshot,
    safetyScores,
    safetyCoverageRatio,
    safetySnapshotDegraded,
    scoresObj,
  } = await loadYieldSyncState({
    db,
    startSec,
    signal,
    chainRpcs,
    etherscanApiKey,
  });
  const riskFreeRate = riskFreeRateMeta.rate;

  if (safetySnapshotDegraded) {
    console.warn(
      `[sync-yield-data] Safety snapshot coverage degraded: ${safetySnapshot.coveredCount}/${safetySnapshot.trackedCount} ` +
      `(${(safetyCoverageRatio * 100).toFixed(1)}%)${safetySnapshot.reason ? ` reason=${safetySnapshot.reason}` : ""}`,
    );
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
    riskFreeRates,
    signal,
    chainRpcs,
    coingeckoApiKey,
    supplementalCandidates,
    stablecoinSupplyById,
  });

  const resolvedWithYield = resolved.filter((entry) => entry.yield != null);
  const resolvedYieldBearingIds = new Set(
    resolvedWithYield
      .filter((entry) => yieldCoinIdSet.has(entry.id))
      .map((entry) => entry.id),
  );
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
    riskFreeRates,
    tier1PrevRates,
    sourceHistory,
    onChainCompatibilityHistoryById,
    legacyDeterministicOnChainHistoryById,
    legacyHistoryById,
    prevTvlBySource,
    legacyPrevTvlById,
    prevBestSourceKeyByCoin,
  });

  const deterministicSourceIds = Array.from(
    new Set(ON_CHAIN_RATE_CONFIGS.map((config) => config.stablecoinId)),
  );
  const nonOnchainEvaluatedIds = new Set(
    evaluatedSources
      .filter((source) => source.dataSource !== "onchain")
      .map((source) => source.id),
  );
  const onChainAlternativeCoverageMissingIds = deterministicSourceIds.filter(
    (id) => !nonOnchainEvaluatedIds.has(id),
  );
  const maskedAllDeterministicFailure =
    allDeterministicFailed &&
    deterministicSourceIds.length > 0 &&
    onChainAlternativeCoverageMissingIds.length === 0;
  const nextOnChainHealthState = buildNextDeterministicOnChainHealthState({
    deterministicConfigCount: deterministicSourceIds.length,
    previous: onChainHealthState,
    startSec,
    onChainAttemptedCount,
    onChainRatesResolved: onChainRates.size,
    allDeterministicFailed,
    maskedAllDeterministicFailure,
    onChainAlternativeCoverageMissingIds,
    onChainSkippedDueToCooldown,
  });
  const onChainCooldownTriggered =
    !onChainCooldownActive &&
    nextOnChainHealthState.cooldownUntil != null &&
    nextOnChainHealthState.cooldownUntil > startSec;
  await persistDeterministicOnChainHealthState(db, startSec, nextOnChainHealthState);

  {
    const nativeApyByCoin = new Map<string, number>();
    const lendingApyByCoin = new Map<string, number>();
    for (const source of evaluatedSources) {
      if (source.yieldType === "lending-opportunity") {
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
  const yieldCoverageRatio = yieldCoins.length > 0 ? resolvedYieldBearingIds.size / yieldCoins.length : 1;
  if (yieldCoins.length >= MIN_YIELD_COINS_FOR_GUARD && yieldCoverageRatio < MIN_YIELD_COVERAGE_RATIO) {
    console.error(
      `[sync-yield-data] Yield coverage regression: ${resolvedYieldBearingIds.size}/${yieldCoins.length} ` +
      `(${(yieldCoverageRatio * 100).toFixed(1)}%) — skipping persistence`,
    );
    return {
      status: "degraded" as const,
      itemCount: resolvedYieldBearingIds.size,
      metadata: JSON.stringify({
        reason: "coverage-regression",
        coverage: yieldCoverageRatio,
        resolvedCount: resolvedYieldBearingIds.size,
        totalCount: yieldCoins.length,
      }),
    };
  }

  const safetySnapshotMeta = buildYieldSafetySnapshotMeta({
    kind: safetySnapshot.kind,
    coverageRatio: safetyCoverageRatio,
    coveredCount: safetySnapshot.coveredCount,
    trackedCount: safetySnapshot.trackedCount,
    reason: safetySnapshot.reason ?? null,
  });

  const previewRankingProvenanceByKey = new Map<string, Record<string, unknown>>();
  for (const source of evaluatedSources) {
    previewRankingProvenanceByKey.set(
      buildHistoryKey(source.id, source.sourceKey),
      buildYieldSourceProvenance({
        source,
        isBest: bestSourceKeyByCoin.get(source.id) === source.sourceKey,
        evaluatedSources,
        startSec,
        dlPoolsMeta,
      }),
    );
  }

  const previewRankingsPayload = buildYieldRankingsPayloadFromEvaluatedSources({
    evaluatedSources,
    bestSourceKeyByCoin,
    rankingProvenanceByKey: previewRankingProvenanceByKey,
    riskFreeRate,
    riskFreeRateMeta,
    riskFreeRateRegistry: toYieldBenchmarkRegistry(riskFreeRates),
    dlPoolsMeta,
    safetySnapshot: safetySnapshotMeta,
    medianApy,
    startSec,
  });

  const previousRankingsState = await readPreviousYieldRankingsCount(db, { allowedIds: yieldCoinIdSet });
  if (previousRankingsState.malformed) {
    return {
      status: "degraded",
      itemCount: previewRankingsPayload.rankings.filter((ranking) => yieldCoinIdSet.has(ranking.id)).length,
      metadata: JSON.stringify({
        reason: "previous-yield-rankings-cache-invalid",
      }),
    };
  }
  const previousPublishedYieldBearingCount = previousRankingsState.count;
  const currentPublishedYieldBearingCount = previewRankingsPayload.rankings
    .filter((ranking) => yieldCoinIdSet.has(ranking.id))
    .length;
  if (
    previousPublishedYieldBearingCount >= MIN_YIELD_COINS_FOR_GUARD &&
    currentPublishedYieldBearingCount < Math.ceil(previousPublishedYieldBearingCount * MIN_YIELD_COVERAGE_RATIO)
  ) {
    return {
      status: "degraded",
      itemCount: currentPublishedYieldBearingCount,
      metadata: JSON.stringify({
        reason: "published-yield-coverage-regression",
        previousPublishedYieldBearingCount,
        currentPublishedYieldBearingCount,
      }),
    };
  }

  if (allDeterministicFailed && maskedAllDeterministicFailure) {
    console.warn(
      "[sync-yield-data] Deterministic on-chain lane failed, but all configured coins retained non-onchain yield coverage",
    );
  }
  const degradationReasons = buildYieldDegradationReasons({
    safetySnapshotDegraded,
    safetySnapshotReason: safetySnapshot.reason ?? null,
    riskFreeRateMeta,
    dlPoolsMeta,
    allDeterministicFailed,
    maskedAllDeterministicFailure,
    onChainSkippedDueToCooldown,
    onChainAlternativeCoverageMissingIds,
  });

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
    metadata: buildYieldSyncMetadata({
      rowsRead: yieldCoins.length,
      rowsWritten: updatedCount,
      rowsRejected,
      divergenceFlags,
      sourceSwitches,
      defaultSafetyCoinCount: defaultSafetyIds.size,
      safetySnapshot: safetySnapshotMeta,
      resolvedYieldBearingCount: resolvedYieldBearingIds.size,
      expectedYieldBearingCount: yieldCoins.length,
      publishedYieldBearingCount: currentPublishedYieldBearingCount,
      previousPublishedYieldBearingCount,
      dlPoolsMeta,
      supplementalMeta,
      onChainRatesResolved: onChainRates.size,
      onChainRatesConfigured: ON_CHAIN_RATE_CONFIGS.length,
      onChainAttempted: onChainAttemptedCount,
      onChainAllDeterministicFailed: allDeterministicFailed,
      onChainExplorerAttempted: onChainExplorerAttemptedCount,
      onChainExplorerResolved: onChainExplorerResolvedCount,
      onChainFailureMaskedByAlternativeCoverage: maskedAllDeterministicFailure,
      onChainAlternativeCoverageMissingIds,
      onChainFailures,
      onChainSkippedDueToCooldown,
      onChainCooldownActive,
      onChainCooldownTriggered,
      onChainCooldownUntil: nextOnChainHealthState.cooldownUntil,
      onChainCooldownRemainingSec,
      onChainConsecutiveAllFailRuns: nextOnChainHealthState.consecutiveAllFailRuns,
      onChainConsecutiveMaskedAllFailRuns: nextOnChainHealthState.consecutiveMaskedAllFailRuns,
      fallbackMode: degradationReasons.length > 0 ? degradationReasons.join(",") : null,
      validationFailures,
      riskFreeRate,
      cacheWriteSkipped: !cacheWrite.ok,
    }),
  };
}
