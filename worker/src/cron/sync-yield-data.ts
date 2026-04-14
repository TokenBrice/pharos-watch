// worker/src/cron/sync-yield-data.ts
import { ACTIVE_YIELD_BEARING_STABLECOINS } from "@shared/lib/tracked-stablecoin-utils";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import type { CronResult } from "../lib/cron-logger";
import { ON_CHAIN_RATE_CONFIGS } from "./yield-config";
import type { ChainRpcConfig } from "../lib/chain-registry";
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
import {
  buildYieldDegradationReasons,
  buildYieldSafetySnapshotMeta,
  buildYieldSyncMetadata,
} from "./yield-sync/coordinator-metadata";
import {
  loadYieldSyncState,
} from "./yield-sync/state-loading";
import {
  buildPreviewYieldRankingsArtifacts,
  publishYieldCoordinatorResults,
} from "./yield-sync/coordinator-persist";
import {
  guardPublishedYieldCoverage,
  guardTrackedYieldCoverage,
} from "./yield-sync/coordinator-guards";
import {
  computeDeterministicOnChainHealth,
  logYieldApyDivergences,
} from "./yield-sync/coordinator-health";
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

  const {
    maskedAllDeterministicFailure,
    onChainAlternativeCoverageMissingIds,
    nextOnChainHealthState,
    onChainCooldownTriggered,
  } = await computeDeterministicOnChainHealth({
    db,
    startSec,
    evaluatedSources,
    onChainHealthState,
    onChainCooldownActive,
    onChainSkippedDueToCooldown,
    onChainAttemptedCount,
    onChainRatesResolved: onChainRates.size,
    allDeterministicFailed,
  });

  logYieldApyDivergences(evaluatedSources);

  const trackedCoverageGuard = guardTrackedYieldCoverage({
    resolvedYieldBearingCount: resolvedYieldBearingIds.size,
    expectedYieldBearingCount: yieldCoins.length,
  });
  if (trackedCoverageGuard) {
    return trackedCoverageGuard;
  }

  const safetySnapshotMeta = buildYieldSafetySnapshotMeta({
    kind: safetySnapshot.kind,
    coverageRatio: safetyCoverageRatio,
    coveredCount: safetySnapshot.coveredCount,
    trackedCount: safetySnapshot.trackedCount,
    reason: safetySnapshot.reason ?? null,
  });

  const { previewRankingsPayload } = buildPreviewYieldRankingsArtifacts({
    evaluatedSources,
    bestSourceKeyByCoin,
    riskFreeRate,
    riskFreeRateMeta,
    riskFreeRates,
    dlPoolsMeta,
    safetySnapshot: safetySnapshotMeta,
    medianApy,
    startSec,
  });
  const publishedCoverageGuard = await guardPublishedYieldCoverage({
    db,
    previewRankingsPayload,
    yieldCoinIdSet,
  });
  if (publishedCoverageGuard.result) {
    return publishedCoverageGuard.result;
  }
  const {
    previousPublishedYieldBearingCount,
    currentPublishedYieldBearingCount,
  } = publishedCoverageGuard;

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
  const publicationResult = await publishYieldCoordinatorResults({
    db,
    previewRankingsPayload,
    evaluatedSources,
    bestSourceKeyByCoin,
    startSec,
    medianApy,
    dlPoolsMeta,
    degradationReasons,
    resolvedCount: resolvedIds.length,
    rowsRejected,
    divergenceFlags,
    sourceSwitches,
  });
  if (!publicationResult.ok) {
    return publicationResult.result;
  }

  console.log(
    `[sync-yield-data] Updated ${publicationResult.updatedCount} source rows (${yieldCoins.length} yield-bearing + auto-discovered)`,
  );
  const status = publicationResult.degradationReasons.length > 0 ? "degraded" : "ok";
  return {
    itemCount: publicationResult.updatedCount,
    ...(status === "degraded" ? { status: "degraded" as const } : {}),
    metadata: buildYieldSyncMetadata({
      rowsRead: yieldCoins.length,
      rowsWritten: publicationResult.updatedCount,
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
      fallbackMode: publicationResult.degradationReasons.length > 0 ? publicationResult.degradationReasons.join(",") : null,
      validationFailures: publicationResult.validationFailures,
      riskFreeRate,
      cacheWriteSkipped: publicationResult.cacheWriteSkipped,
    }),
  };
}
