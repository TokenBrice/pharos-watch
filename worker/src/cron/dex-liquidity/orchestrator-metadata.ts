import type { HistoricalSnapshotWriteResult, PersistScoresResult } from "./persistence";
import type { DexLiquidityPostScoreAnalysis } from "./orchestrator-analysis";
import type { DexPaginationPersistenceSummary } from "../../lib/dex-api-common";
import type { DexPricePersistenceDiagnostics } from "./scoring";
import {
  POOL_REJECTION_MATERIAL_TVL_USD,
  hasMaterialPoolRejections,
} from "./process-pools";
import type { PoolProcessingRejection } from "./process-pool-types";
import type { LiquidityFallbackCounters } from "./types";

export type { DexLiquidityPostScoreAnalysis } from "./orchestrator-analysis";
export { analyzeDexLiquidityPostScoring } from "./orchestrator-analysis";

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
  rowsRead: number;
  rowsWritten: number;
  stagedPoolsMerged: number;
  stagedPoolsSkipped: number;
  stagedPoolsSkippedByExactIdentity: number;
  stagedPoolsSkippedByUniqueDerivedIdentity: number;
  stagedPoolsSkippedByOptionalWildcardIdentity: number;
  stagedPoolsSkippedByAuthoritativeProtocol: number;
  stagedPoolSkipDimensions: Array<{
    reason: string;
    protocol: string;
    chain: string;
    count: number;
    threshold?: number;
    conflict?: string;
  }>;
  poolRejections: PoolProcessingRejection[];
  directApiSourceSummary: {
    acceptedByProtocolChain: Record<string, number>;
    excludedByReason: Record<string, number>;
    circuitEvents: Array<{ circuitKey: string; from: string; to: string; at: number | null }>;
    sourceWarnings: string[];
    pagination: Array<{
      source: string;
      state: "complete" | "partial";
      headRefreshed: boolean;
      pagesFetched: number;
      cursor: string | null;
      cycleCompleted: boolean;
      cursorPersistence?: DexPaginationPersistenceSummary;
    }>;
  };
  sourceCoverage: DexLiquidityPostScoreAnalysis["sourceCoverage"];
  challengerPublication: {
    publishedStablecoins: number;
    skippedStablecoins: number;
    missingTables: boolean;
  };
  dexPriceDiagnostics: DexPricePersistenceDiagnostics;
  failedSources: string[];
  fallbackSignals: string[];
  fallbackCounters: LiquidityFallbackCounters;
  persistence: PersistScoresResult;
  historicalSnapshot: HistoricalSnapshotWriteResult;
}): Record<string, unknown> {
  const rejectedPoolCount = params.poolRejections.reduce(
    (sum, rejection) => sum + rejection.count,
    0,
  );
  const rejectedPoolTvlUsd = params.poolRejections.reduce(
    (sum, rejection) => sum + rejection.tvlUsd,
    0,
  );
  return {
    rowsRead: params.rowsRead,
    rowsWritten: params.rowsWritten,
    rowsDropped: rejectedPoolCount,
    stagedPoolsMerged: params.stagedPoolsMerged,
    stagedPoolsSkipped: params.stagedPoolsSkipped,
    stagedPoolsSkippedByExactIdentity: params.stagedPoolsSkippedByExactIdentity,
    stagedPoolsSkippedByUniqueDerivedIdentity: params.stagedPoolsSkippedByUniqueDerivedIdentity,
    stagedPoolsSkippedByOptionalWildcardIdentity: params.stagedPoolsSkippedByOptionalWildcardIdentity,
    stagedPoolsSkippedByAuthoritativeProtocol: params.stagedPoolsSkippedByAuthoritativeProtocol,
    stagedPoolSkipDimensions: params.stagedPoolSkipDimensions,
    poolRejections: params.poolRejections,
    poolRejectionMateriality: {
      thresholdTvlUsd: POOL_REJECTION_MATERIAL_TVL_USD,
      rejectedPoolCount,
      rejectedPoolTvlUsd,
      material: hasMaterialPoolRejections(params.poolRejections),
    },
    directApiSourceSummary: params.directApiSourceSummary,
    sourceCoverage: {
      ...params.sourceCoverage,
      challengerSnapshotsPublished: params.challengerPublication.publishedStablecoins,
      challengerSnapshotsSkipped: params.challengerPublication.skippedStablecoins,
      challengerSnapshotTablesMissing: params.challengerPublication.missingTables,
    },
    failedSources: [...new Set(params.failedSources)],
    dexPriceDiagnostics: params.dexPriceDiagnostics,
    fallbackMode: [...new Set(params.fallbackSignals)],
    fallbackCounters: params.fallbackCounters,
    persistence: {
      generationId: params.persistence.generationId ?? null,
      expectedRowCount: params.persistence.expectedRowCount ?? null,
      candidateRowsWritten: params.persistence.candidateRowsWritten ?? null,
      currentGenerationRows: params.persistence.currentGenerationRows ?? null,
      placeholderRowsWritten: params.persistence.placeholderCount,
      inactiveMetricRowsSkipped: params.persistence.inactiveMetricRowsSkipped,
      inactiveMetricIdsSkipped: params.persistence.inactiveMetricIdsSkipped?.slice(0, 25) ?? [],
      orphanRowsDeleted: params.persistence.orphanRowsDeleted,
      orphanCleanupFailed: params.persistence.orphanCleanupFailed,
      retention: params.persistence.retention ?? null,
      skipped: params.persistence.skipped ?? false,
      skippedReason: params.persistence.skippedReason ?? null,
      historicalSnapshotRowsWritten: params.historicalSnapshot.snapshotRowsWritten,
      historicalSnapshotSkipped: params.historicalSnapshot.skipped,
      historicalSnapshotWriteFailed: params.historicalSnapshot.writeFailed,
      historicalSnapshotRowsPruned: params.historicalSnapshot.historyRowsPruned,
      historicalSnapshotRetentionPruneFailed: params.historicalSnapshot.retentionPruneFailed,
    },
    validationFailures: rejectedPoolCount,
  };
}
