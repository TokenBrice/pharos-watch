import type { HistoricalSnapshotWriteResult, PersistScoresResult } from "./persistence";
import type { DexLiquidityPostScoreAnalysis } from "./orchestrator-analysis";
import type { DeadPoolExclusionSummary, DexPricePersistenceDiagnostics } from "./scoring";
import {
  POOL_REJECTION_MATERIAL_TVL_USD,
  hasMaterialPoolRejections,
} from "./process-pools";
import type { PoolProcessingRejection } from "./process-pool-types";
import type { LiquidityFallbackCounters } from "./types";
import type { MeasuredTargetFunnel } from "./route-telemetry";
import type { DexLiquidityScoringSourceState, DexLiquidityPoolState } from "./scoring-stage-contract";

export function isDexLiquidityDegraded(params: {
  criticalSourceFailures: string[];
  poolRejections?: PoolProcessingRejection[];
  analysis: DexLiquidityPostScoreAnalysis;
  persistence: PersistScoresResult;
  dexPriceDiagnostics?: DexPricePersistenceDiagnostics;
  historicalSnapshot: HistoricalSnapshotWriteResult;
}): boolean {
  return (
    params.criticalSourceFailures.length > 0 ||
    hasMaterialPoolRejections(params.poolRejections) ||
    !params.analysis.previousCoverageBaselineAvailable ||
    params.analysis.nearCoverageGuard ||
    params.analysis.nearValueGuard ||
    params.analysis.nearMajorCoverageGuard ||
    params.persistence.orphanCleanupFailed ||
    params.persistence.retention?.error != null ||
    params.dexPriceDiagnostics?.retention?.error != null ||
    params.historicalSnapshot.writeFailed ||
    params.historicalSnapshot.retentionPruneFailed
  );
}

export function buildDexLiquidityCronMetadata(params: {
  sourceState: Pick<DexLiquidityScoringSourceState,
    "primaryRawPoolCount" | "failedSources" | "degradedSources" |
    "fallbackSignals" | "directApiSourceSummary">;
  poolState: Pick<DexLiquidityPoolState,
    "stagedMergedCount" | "stagedSkippedCount" | "stagedSkippedByExactIdentityCount" |
    "stagedSkippedByUniqueDerivedIdentityCount" | "stagedSkippedByOptionalWildcardIdentityCount" |
    "stagedSkippedByAuthoritativeProtocolCount" | "stagedSkipDimensions" |
    "registryRowsRead" | "registryMultiSourcePools" |
    "registryFamilyBySource" | "stagedWritebackRows" | "stagedWritebackSkippedUntrustedIds" |
    "poolRejections" | "deadPoolUnindexedChainSkips"> & {
    registryEvaluatedAtSec?: number;
    directApiIntegration: Pick<DexLiquidityPoolState["directApiIntegration"],
      "acceptedByProtocolChain" | "excludedByReason">;
  };
  scoreState: {
    scoreResults: Pick<ReadonlyMap<string, unknown>, "size">;
    analysis: Pick<DexLiquidityPostScoreAnalysis, "sourceCoverage">;
    diagnostics: {
      fallbackCounters: LiquidityFallbackCounters;
      deadPoolExclusions: DeadPoolExclusionSummary;
      measuredTargetFunnel?: MeasuredTargetFunnel;
    };
  };
  persistenceState: {
    persistence: PersistScoresResult;
    challengerPublication: { publishedStablecoins: number; skippedStablecoins: number };
    dexPriceDiagnostics: DexPricePersistenceDiagnostics;
    historicalSnapshot: HistoricalSnapshotWriteResult;
  };
}): Record<string, unknown> {
  const { sourceState, poolState, scoreState } = params;
  const { persistence, historicalSnapshot, challengerPublication, dexPriceDiagnostics } = params.persistenceState;
  const rejectedPoolCount = poolState.poolRejections.reduce((sum, rejection) => sum + rejection.count, 0);
  const rejectedPoolTvlUsd = poolState.poolRejections.reduce((sum, rejection) => sum + rejection.tvlUsd, 0);
  return {
    rowsRead: sourceState.primaryRawPoolCount,
    rowsWritten: persistence.skipped || persistence.skippedReason === "liquidity-cadence-reuse"
      ? 0 : scoreState.scoreResults.size,
    rowsDropped: rejectedPoolCount,
    stagedPoolsMerged: poolState.stagedMergedCount,
    stagedPoolsSkipped: poolState.stagedSkippedCount,
    stagedPoolsSkippedByExactIdentity: poolState.stagedSkippedByExactIdentityCount,
    stagedPoolsSkippedByUniqueDerivedIdentity: poolState.stagedSkippedByUniqueDerivedIdentityCount,
    stagedPoolsSkippedByOptionalWildcardIdentity: poolState.stagedSkippedByOptionalWildcardIdentityCount,
    stagedPoolsSkippedByAuthoritativeProtocol: poolState.stagedSkippedByAuthoritativeProtocolCount,
    stagedPoolSkipDimensions: poolState.stagedSkipDimensions,
    stagedWritebackRows: poolState.stagedWritebackRows,
    stagedWritebackSkippedUntrustedIds: poolState.stagedWritebackSkippedUntrustedIds,
    registryEvaluation: poolState.registryEvaluatedAtSec == null ? undefined : {
      evaluatedAtSec: poolState.registryEvaluatedAtSec,
      basis: "registry-read-consumed",
    },
    registryRowsRead: poolState.registryRowsRead,
    registryMultiSourcePools: poolState.registryMultiSourcePools,
    registryFamilyBySource: poolState.registryFamilyBySource,
    poolRejections: poolState.poolRejections,
    poolRejectionMateriality: {
      thresholdTvlUsd: POOL_REJECTION_MATERIAL_TVL_USD,
      rejectedPoolCount,
      rejectedPoolTvlUsd,
      material: hasMaterialPoolRejections(poolState.poolRejections),
    },
    directApiSourceSummary: {
      acceptedByProtocolChain: poolState.directApiIntegration.acceptedByProtocolChain,
      excludedByReason: poolState.directApiIntegration.excludedByReason,
      circuitEvents: sourceState.directApiSourceSummary.circuitEvents,
      sourceWarnings: sourceState.directApiSourceSummary.sourceWarnings,
      pagination: sourceState.directApiSourceSummary.pagination,
    },
    sourceCoverage: {
      ...scoreState.analysis.sourceCoverage,
      challengerSnapshotsPublished: challengerPublication.publishedStablecoins,
      challengerSnapshotsSkipped: challengerPublication.skippedStablecoins,
    },
    failedSources: [...new Set(sourceState.failedSources)],
    degradedSources: [...new Set(sourceState.degradedSources ?? [])],
    dexPriceDiagnostics,
    fallbackMode: [...new Set(sourceState.fallbackSignals)],
    fallbackCounters: scoreState.diagnostics.fallbackCounters,
    retainedDeadPoolExclusions: scoreState.diagnostics.deadPoolExclusions,
    deadPoolUnindexedChainSkips: poolState.deadPoolUnindexedChainSkips ?? {},
    measuredTargetFunnel: scoreState.diagnostics.measuredTargetFunnel,
    exitRouteSelection: persistence.exitRouteSelection,
    exitRouteContinuity: persistence.exitRouteContinuity,
    persistence: {
      generationId: persistence.generationId ?? null,
      expectedRowCount: persistence.expectedRowCount ?? null,
      candidateRowsWritten: persistence.candidateRowsWritten ?? null,
      currentGenerationRows: persistence.currentGenerationRows ?? null,
      placeholderRowsWritten: persistence.placeholderCount,
      inactiveMetricRowsSkipped: persistence.inactiveMetricRowsSkipped,
      inactiveMetricIdsSkipped: persistence.inactiveMetricIdsSkipped?.slice(0, 25) ?? [],
      orphanRowsDeleted: persistence.orphanRowsDeleted,
      orphanCleanupFailed: persistence.orphanCleanupFailed,
      retention: persistence.retention ?? null,
      skipped: persistence.skipped ?? false,
      skippedReason: persistence.skippedReason ?? null,
      historicalSnapshotRowsWritten: historicalSnapshot.snapshotRowsWritten,
      historicalSnapshotSkipped: historicalSnapshot.skipped,
      historicalSnapshotWriteFailed: historicalSnapshot.writeFailed,
      historicalSnapshotRowsPruned: historicalSnapshot.historyRowsPruned,
      historicalSnapshotRetentionPruneFailed: historicalSnapshot.retentionPruneFailed,
    },
  };
}
