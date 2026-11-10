import type { HistoricalSnapshotWriteResult, PersistScoresResult } from "./persistence";
import type { DexLiquidityPostScoreAnalysis } from "./orchestrator-analysis";
import type { DeadPoolExclusionSummary, DexPricePersistenceDiagnostics } from "./scoring";
import {
  buildPoolRejectionMetadata,
} from "./process-pools";
import type { CurveStableswapPlainAdmissionDiagnostic, LiquidityFallbackCounters } from "./types";
import { boundTelemetryEntries, type MeasuredTargetFunnel } from "./route-telemetry";
import type { DexLiquidityScoringSourceState, DexLiquidityPoolState } from "./scoring-stage-contract";
import { SOURCE_FAMILY_DROP_FLAG_PREFIX } from "./orchestrator-drift";

/** Cron copies share the job budget with rejection evidence; the scoring-stage payload stays complete. */
export function boundDexLiquidityPriceRefreshMetadata(summary: DexLiquidityPoolState["priceRefresh"]) {
  if (!summary) return summary;
  const networks = boundTelemetryEntries(summary.demand.networks, 8, 512);
  const failures = boundTelemetryEntries(summary.failures, 3, 512);
  return { ...summary,
    demand: { ...summary.demand, networks, networksOmitted: summary.demand.networks.length - networks.length },
    failures, failuresOmitted: summary.failuresOmitted + summary.failures.length - failures.length,
  };
}

export function getDexLiquiditySourceQualityReasons(sourceState: Pick<DexLiquidityScoringSourceState,
  "failedSources" | "degradedSources" | "directApiSourceSummary">): string[] {
  return [...new Set([
    ...sourceState.failedSources.map((source) => `source-failed:${source}`),
    ...(sourceState.degradedSources ?? []).map((source) => `source-partial:${source}`),
    ...(sourceState.directApiSourceSummary.sourceWarnings.length > 0 ? ["direct-api-source-warnings"] : []),
  ])];
}

/**
 * R4: the bounded machine-readable cause of a degraded run. Also the single
 * authority for the status predicate, so a published `degraded` status and its
 * `metadata.reason` can never disagree.
 */
export function dexLiquidityDegradedReason(params: {
  criticalSourceFailures: string[];
  analysis: DexLiquidityPostScoreAnalysis;
  persistence: PersistScoresResult;
  dexPriceDiagnostics?: DexPricePersistenceDiagnostics;
  historicalSnapshot: HistoricalSnapshotWriteResult;
}): string | null {
  if (params.criticalSourceFailures.length > 0) return "critical-source-failures";
  const rejectionReason = params.analysis.sourceCoverage?.poolRejectionCoverage?.reason;
  if (rejectionReason) return rejectionReason;
  if (!params.analysis.previousCoverageBaselineAvailable) return "previous-coverage-baseline-unavailable";
  if (params.analysis.requiredBaselineUnavailable) return "required-baseline-unavailable";
  if (params.analysis.nearCoverageGuard) return "near-coverage-guard";
  if (params.analysis.nearValueGuard) return "near-value-guard";
  if (params.analysis.nearMajorCoverageGuard) return "near-major-coverage-guard";
  if (params.persistence.orphanCleanupFailed) return "orphan-cleanup-failed";
  if (params.persistence.retention?.error != null || params.dexPriceDiagnostics?.retention?.error != null) {
    return "retention-prune-failed";
  }
  if (params.historicalSnapshot.writeFailed) return "historical-snapshot-write-failed";
  if (params.historicalSnapshot.retentionPruneFailed) return "historical-snapshot-retention-prune-failed";
  return null;
}

export function buildDexLiquidityCronMetadata(params: {
  sourceState: Pick<DexLiquidityScoringSourceState,
    "primaryRawPoolCount" | "failedSources" | "degradedSources" |
    "fallbackSignals" | "directApiSourceSummary" | "subgraphFailures">;
  poolState: Pick<DexLiquidityPoolState,
    "stagedMergedCount" | "stagedSkippedCount" | "stagedSkippedByExactIdentityCount" |
    "stagedSkippedByUniqueDerivedIdentityCount" | "stagedSkippedByOptionalWildcardIdentityCount" |
    "stagedSkippedByAuthoritativeProtocolCount" | "stagedSkipDimensions" |
    "registryRowsRead" | "registryMultiSourcePools" |
    "registryFamilyBySource" | "stagedWritebackRows" | "stagedWritebackSkippedUntrustedIds" |
    "poolRejections" | "deadPoolUnindexedChainSkips" | "priceRefresh"> & {
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
      curveStableswapPlainAdmissions?: CurveStableswapPlainAdmissionDiagnostic[];
      curveStableswapPlainAdmissionsOmitted?: number;
    };
  };
  persistenceState: {
    persistence: PersistScoresResult;
    challengerPublication: { publishedStablecoins: number; skippedStablecoins: number };
    dexPriceDiagnostics: DexPricePersistenceDiagnostics;
    historicalSnapshot: HistoricalSnapshotWriteResult;
  };
  /** `dexLiquidityDegradedReason` for the same state; null/absent for an okay run. */
  degradedReason?: string | null;
}): Record<string, unknown> {
  const { sourceState, poolState, scoreState } = params;
  const { persistence, historicalSnapshot, challengerPublication, dexPriceDiagnostics } = params.persistenceState;
  const rejectedPoolCount = poolState.poolRejections.reduce((sum, rejection) => sum + rejection.count, 0);
  // Chain TVL can fall with complete inputs; retained source-pool loss is coverage evidence.
  const sourceFamilyDriftFlags = (scoreState.analysis.sourceCoverage.cohortDriftFlags ?? [])
    .filter((flag) => flag.startsWith(SOURCE_FAMILY_DROP_FLAG_PREFIX));
  const qualityReasons = [...new Set([
    ...sourceFamilyDriftFlags,
    ...(scoreState.analysis.sourceCoverage.qualityDriftFlags ?? []),
    ...getDexLiquiditySourceQualityReasons(sourceState),
  ])];
  return {
    ...(persistence.skippedReason === "required-baseline-read-failed"
      ? { reason: "required-baseline-read-failed" }
      : params.degradedReason != null ? { reason: params.degradedReason } : {}),
    ...(qualityReasons.length > 0
      ? { quality: { ...(sourceFamilyDriftFlags.length > 0 ? { degraded: true } : {}), reasons: qualityReasons } }
      : {}),
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
    priceRefresh: boundDexLiquidityPriceRefreshMetadata(poolState.priceRefresh),
    stagedWritebackSkippedUntrustedIds: poolState.stagedWritebackSkippedUntrustedIds,
    registryEvaluation: poolState.registryEvaluatedAtSec == null ? undefined : {
      evaluatedAtSec: poolState.registryEvaluatedAtSec,
      basis: "registry-read-consumed",
    },
    registryRowsRead: poolState.registryRowsRead,
    registryMultiSourcePools: poolState.registryMultiSourcePools,
    registryFamilyBySource: poolState.registryFamilyBySource,
    ...buildPoolRejectionMetadata(poolState.poolRejections, scoreState.analysis.sourceCoverage.poolRejectionCoverage),
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
    subgraphFailures: sourceState.subgraphFailures ?? [],
    degradedSources: [...new Set(sourceState.degradedSources ?? [])],
    dexPriceDiagnostics,
    fallbackMode: [...new Set(sourceState.fallbackSignals)],
    fallbackCounters: scoreState.diagnostics.fallbackCounters,
    retainedDeadPoolExclusions: scoreState.diagnostics.deadPoolExclusions,
    deadPoolUnindexedChainSkips: poolState.deadPoolUnindexedChainSkips ?? {},
    measuredTargetFunnel: scoreState.diagnostics.measuredTargetFunnel,
    ...(scoreState.diagnostics.curveStableswapPlainAdmissions?.length
      ? {
          curveStableswapPlainAdmissions: scoreState.diagnostics.curveStableswapPlainAdmissions,
          curveStableswapPlainAdmissionsOmitted: scoreState.diagnostics.curveStableswapPlainAdmissionsOmitted ?? 0,
        }
      : {}),
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
