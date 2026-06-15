// worker/src/cron/sync-yield-data.ts
import { ACTIVE_YIELD_BEARING_STABLECOINS } from "@shared/lib/tracked-stablecoin-utils";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import type { CronProgressReporter, CronResult } from "../lib/cron-logger";
import { getCache } from "../lib/db-cache";
import { reportCronProgress } from "../lib/cron-progress";
import { ON_CHAIN_RATE_CONFIGS } from "./yield-config";
import type { ChainRpcConfig } from "../lib/chain-registry";
import {
  YIELD_HISTORY_CLEANUP_WRITER_PAUSE_KEY,
  parseYieldHistoryWriterPause,
} from "../lib/yield-history-cleanup";
import { resolveYieldSources } from "./yield-sync/resolve";
import {
  loadYieldHistorySnapshots,
  purgeYieldHistoryOwnershipHandoffs,
} from "./yield-sync/history";
import {
  evaluateYieldSourcesCooperative,
} from "./yield-sync/evaluation";
import { buildYieldHistoryEvaluationInputsCooperative } from "./yield-sync/coordinator-history";
import {
  buildComparisonAnchorFreshnessMeta,
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
import { repairPublishedYieldGenerationFromCache } from "./yield-sync/publication";
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
  reportProgress?: CronProgressReporter,
): Promise<CronResult> {
  const startSec = Math.floor(Date.now() / 1000);
  const sevenDaysAgoSec = startSec - 7 * DAY_SECONDS;
  const yieldCoins = ACTIVE_YIELD_BEARING_STABLECOINS;
  const yieldCoinIdSet = new Set(yieldCoins.map((coin) => coin.id));
  const opportunityCoinIdSet = new Set(
    ACTIVE_STABLECOINS
      .map((coin) => coin.id)
      .filter((id) => !yieldCoinIdSet.has(id)),
  );
  const progressTotal = yieldCoins.length + opportunityCoinIdSet.size;
  const reportYieldProgress = async (
    stage: string,
    message: string,
    providerFamily: string,
    options: {
      itemsDone?: number;
      itemsTotal?: number;
      metadata?: Record<string, unknown>;
    } = {},
  ) => {
    await reportCronProgress(reportProgress, {
      stage,
      message,
      itemsDone: options.itemsDone,
      itemsTotal: options.itemsTotal ?? progressTotal,
      metadata: {
        providerFamily,
        phase: stage,
        countTotals: {
          yieldBearingCoins: yieldCoins.length,
          opportunityCoins: opportunityCoinIdSet.size,
          totalTrackedForYield: progressTotal,
        },
        ...options.metadata,
      },
    });
  };

  await reportYieldProgress("preflight", "Preparing yield publication inputs", "yield", {
    itemsDone: 0,
  });

  if (yieldCoins.length === 0) {
    return { itemCount: 0, metadata: "no yield-bearing coins" };
  }

  const writerPause = parseYieldHistoryWriterPause(
    await getCache(db, YIELD_HISTORY_CLEANUP_WRITER_PAUSE_KEY),
  );
  if (writerPause) {
    await reportYieldProgress("writer-paused", "Yield publication is paused by operator", "yield", {
      itemsDone: 0,
      metadata: {
        writerPaused: true,
        pauseReason: writerPause.reason,
        pauseOperator: writerPause.operator,
        pausedAt: writerPause.pausedAt,
      },
    });
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({
        writerPaused: true,
        pauseReason: writerPause.reason,
        pauseOperator: writerPause.operator,
        pausedAt: writerPause.pausedAt,
      }),
    };
  }

  await purgeYieldHistoryOwnershipHandoffs(db);
  await repairPublishedYieldGenerationFromCache(db, startSec).catch((error: unknown) => {
    console.warn("[sync-yield-data] Failed to repair published yield generation before history load:", error);
  });

  await reportYieldProgress("state-loading", "Loading yield source state and safety snapshots", "yield-source-cache", {
    itemsDone: 0,
    metadata: {
      providerFamilies: ["defillama-yields", "yield-supplemental", "on-chain-rates", "risk-free-rates", "safety-scores"],
    },
  });
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
  await reportYieldProgress("state-loaded", "Loaded yield source state", "yield-source-cache", {
    itemsDone: dlPools.length + supplementalCandidates.length + onChainRates.size,
    metadata: {
      providerFamilies: ["defillama-yields", "yield-supplemental", "on-chain-rates", "risk-free-rates", "safety-scores"],
      countTotals: {
        yieldBearingCoins: yieldCoins.length,
        opportunityCoins: opportunityCoinIdSet.size,
        totalTrackedForYield: progressTotal,
        dlPools: dlPools.length,
        supplementalCandidates: supplementalCandidates.length,
        supplementalSourceCount: supplementalMeta.sourceCount,
        onChainRatesResolved: onChainRates.size,
        onChainRatesConfigured: ON_CHAIN_RATE_CONFIGS.length,
        safetyScoresComputed: safetySnapshot.coveredCount,
        safetyScoresExpected: safetySnapshot.trackedCount,
      },
      supplementalMode: supplementalMeta.mode,
      supplementalFallbackMode: supplementalMeta.fallbackMode,
      onChainCooldownActive,
      onChainCooldownRemainingSec,
    },
  });

  if (safetySnapshotDegraded) {
    console.warn(
      `[sync-yield-data] Safety snapshot coverage degraded: ${safetySnapshot.coveredCount}/${safetySnapshot.trackedCount} ` +
      `(${(safetyCoverageRatio * 100).toFixed(1)}%)${safetySnapshot.reason ? ` reason=${safetySnapshot.reason}` : ""}`,
    );
  }

  await reportYieldProgress("source-resolution", "Resolving yield source candidates", "yield", {
    itemsDone: 0,
    metadata: {
      providerFamilies: ["defillama-yields", "yield-supplemental", "on-chain-rates"],
      countTotals: {
        yieldBearingCoins: yieldCoins.length,
        opportunityCoins: opportunityCoinIdSet.size,
        totalTrackedForYield: progressTotal,
        dlPools: dlPools.length,
        supplementalCandidates: supplementalCandidates.length,
        onChainRatesResolved: onChainRates.size,
      },
    },
  });
  const { resolved, tier1PrevRates, envelopeRejections } = await resolveYieldSources({
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
  await reportYieldProgress("source-resolution-complete", "Resolved yield source candidates", "yield", {
    itemsDone: resolvedWithYield.length,
    metadata: {
      providerFamilies: ["defillama-yields", "yield-supplemental", "on-chain-rates"],
      countTotals: {
        resolvedSources: resolvedWithYield.length,
        resolvedCoins: resolvedIds.length,
        resolvedYieldBearingCoins: resolvedYieldBearingIds.size,
        envelopeRejections: envelopeRejections.length,
      },
    },
  });
  const resolvedCountByCoin = new Map<string, number>();
  for (const entry of resolvedWithYield) {
    resolvedCountByCoin.set(entry.id, (resolvedCountByCoin.get(entry.id) ?? 0) + 1);
  }

  const historySnapshots = resolvedIds.length > 0
    ? await loadYieldHistorySnapshots(db, resolvedIds, startSec, sevenDaysAgoSec, {
        signal,
        onProgress: async (progress) => {
          await reportYieldProgress("history-loading", "Loading yield history snapshots", "yield-history", {
            itemsDone: progress.resolvedIdsDone,
            itemsTotal: progress.resolvedIdsTotal,
            metadata: {
              countTotals: {
                resolvedSources: resolvedWithYield.length,
                resolvedCoins: resolvedIds.length,
                historyRows: progress.historyRows,
                previousTvlRows: progress.prevTvlRows,
                previousBestRows: progress.prevBestRows,
              },
              chunksDone: progress.chunksDone,
              chunksTotal: progress.chunksTotal,
            },
          });
        },
      })
    : { historyRows: [], prevTvlRows: [], prevBestRows: [] };
  await reportYieldProgress("history-loaded", "Loaded yield history snapshots", "yield-history", {
    itemsDone: resolvedIds.length,
    itemsTotal: resolvedIds.length,
    metadata: {
      countTotals: {
        historyRows: historySnapshots.historyRows.length,
        previousTvlRows: historySnapshots.prevTvlRows.length,
        previousBestRows: historySnapshots.prevBestRows.length,
      },
    },
  });
  const {
    sourceHistory,
    onChainCompatibilityHistoryById,
    legacyDeterministicOnChainHistoryById,
    legacyHistoryById,
    prevTvlBySource,
    legacyPrevTvlById,
    prevBestSourceKeyByCoin,
    sourceSwitchCount30dByCoin,
  } = await buildYieldHistoryEvaluationInputsCooperative(historySnapshots, {
    signal,
    onProgress: async (progress) => {
      await reportYieldProgress("history-input-construction", "Preparing yield history evaluation inputs", "yield-history", {
        itemsDone: progress.rowsDone,
        itemsTotal: progress.rowsTotal,
        metadata: {
          phase: progress.phase,
          countTotals: {
            historyRows: historySnapshots.historyRows.length,
            previousTvlRows: historySnapshots.prevTvlRows.length,
            previousBestRows: historySnapshots.prevBestRows.length,
          },
        },
      });
    },
  });

  await reportYieldProgress("evaluation", "Evaluating best yield sources and source risk", "yield", {
    itemsDone: 0,
    metadata: {
      countTotals: {
        resolvedSources: resolvedWithYield.length,
        resolvedCoins: resolvedIds.length,
      },
    },
  });
  const {
    evaluatedSources,
    bestSourceKeyByCoin,
    defaultSafetyIds,
    rowsRejected,
    divergenceFlags,
    sourceSwitches,
    medianApy,
  } = await evaluateYieldSourcesCooperative({
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
    sourceSwitchCount30dByCoin,
    stablecoinSupplyById,
    dlPoolsMeta,
  }, {
    signal,
    onProgress: async (progress) => {
      await reportYieldProgress("evaluation", "Evaluating best yield sources and source risk", "yield", {
        itemsDone: progress.coinsDone,
        itemsTotal: progress.coinsTotal,
        metadata: {
          phase: progress.phase,
          countTotals: {
            evaluatedSources: progress.evaluatedSources,
            bestSourceCoins: progress.bestSourceCoins,
            rowsRejected: progress.rowsRejected,
            divergenceFlags: progress.divergenceFlags,
            sourceSwitches: progress.sourceSwitches,
          },
        },
      });
    },
  });
  await reportYieldProgress("evaluation-complete", "Completed yield source evaluation", "yield", {
    itemsDone: evaluatedSources.length,
    metadata: {
      countTotals: {
        evaluatedSources: evaluatedSources.length,
        bestSourceCoins: bestSourceKeyByCoin.size,
        rowsRejected,
        divergenceFlags,
        sourceSwitches,
      },
    },
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
    await reportYieldProgress("coverage-guard", "Yield tracked coverage guard deferred publication", "yield", {
      itemsDone: resolvedYieldBearingIds.size,
      metadata: {
        guard: "tracked-coverage",
        countTotals: {
          resolvedYieldBearingCoins: resolvedYieldBearingIds.size,
          expectedYieldBearingCoins: yieldCoins.length,
        },
      },
    });
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
    opportunityCoinIdSet,
  });
  if (publishedCoverageGuard.result) {
    await reportYieldProgress("coverage-guard", "Yield published coverage guard deferred publication", "yield-publication", {
      itemsDone: previewRankingsPayload.rankings.length,
      metadata: {
        guard: "published-coverage",
        countTotals: {
          previewRankings: previewRankingsPayload.rankings.length,
        },
      },
    });
    return publishedCoverageGuard.result;
  }
  const {
    previousPublishedYieldBearingCount,
    currentPublishedYieldBearingCount,
    previousPublishedOpportunityCount,
    currentPublishedOpportunityCount,
    previousPublishedRankingCount,
    currentPublishedRankingCount,
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
  await reportYieldProgress("publication", "Publishing yield rankings generation", "yield-publication", {
    itemsDone: 0,
    itemsTotal: previewRankingsPayload.rankings.length,
    metadata: {
      countTotals: {
        previewRankings: previewRankingsPayload.rankings.length,
        evaluatedSources: evaluatedSources.length,
      },
      degradationReasons,
    },
  });
  const publicationResult = await publishYieldCoordinatorResults({
    db,
    signal,
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
    await reportYieldProgress("publication-blocked", "Yield publication was blocked", "yield-publication", {
      itemsDone: 0,
      itemsTotal: previewRankingsPayload.rankings.length,
      metadata: {
        countTotals: {
          previewRankings: previewRankingsPayload.rankings.length,
        },
      },
    });
    return publicationResult.result;
  }

  console.log(
    `[sync-yield-data] Updated ${publicationResult.updatedCount} source rows (${yieldCoins.length} yield-bearing + auto-discovered)`,
  );
  await reportYieldProgress("publication-complete", "Published yield rankings generation", "yield-publication", {
    itemsDone: publicationResult.updatedCount,
    itemsTotal: previewRankingsPayload.rankings.length,
    metadata: {
      countTotals: {
        rowsWritten: publicationResult.updatedCount,
        publishedRankingCount: currentPublishedRankingCount,
        previousPublishedRankingCount,
      },
      degradationReasons: publicationResult.degradationReasons,
      cacheWriteSkipped: publicationResult.cacheWriteSkipped,
    },
  });
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
      publishedOpportunityCount: currentPublishedOpportunityCount,
      previousPublishedOpportunityCount,
      publishedRankingCount: currentPublishedRankingCount,
      previousPublishedRankingCount,
      dlPoolsMeta,
      supplementalMeta,
      onChain: {
        ratesResolved: onChainRates.size,
        ratesConfigured: ON_CHAIN_RATE_CONFIGS.length,
        envelopeRejections,
        attempted: onChainAttemptedCount,
        allDeterministicFailed,
        explorerAttempted: onChainExplorerAttemptedCount,
        explorerResolved: onChainExplorerResolvedCount,
        failureMaskedByAlternativeCoverage: maskedAllDeterministicFailure,
        alternativeCoverageMissingIds: onChainAlternativeCoverageMissingIds,
        failures: onChainFailures,
        skippedDueToCooldown: onChainSkippedDueToCooldown,
        cooldownActive: onChainCooldownActive,
        cooldownTriggered: onChainCooldownTriggered,
        cooldownUntil: nextOnChainHealthState.cooldownUntil,
        cooldownRemainingSec: onChainCooldownRemainingSec,
        consecutiveAllFailRuns: nextOnChainHealthState.consecutiveAllFailRuns,
        consecutiveMaskedAllFailRuns: nextOnChainHealthState.consecutiveMaskedAllFailRuns,
      },
      fallbackMode: publicationResult.degradationReasons.length > 0 ? publicationResult.degradationReasons.join(",") : null,
      validationFailures: publicationResult.validationFailures,
      riskFreeRate,
      cacheWriteSkipped: publicationResult.cacheWriteSkipped,
      comparisonAnchorFreshness: buildComparisonAnchorFreshnessMeta({
        evaluatedSources,
        startSec,
      }),
    }),
  };
}
