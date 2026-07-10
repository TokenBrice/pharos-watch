import type { HistoricalSnapshotWriteResult, PersistScoresResult } from "./persistence";
import type { DexLiquidityPostScoreAnalysis } from "./orchestrator-analysis";

export type { DexLiquidityPostScoreAnalysis } from "./orchestrator-analysis";
export { analyzeDexLiquidityPostScoring } from "./orchestrator-analysis";

export function isDexLiquidityDegraded(params: {
  criticalSourceFailures: string[];
  analysis: DexLiquidityPostScoreAnalysis;
  persistence: PersistScoresResult;
  historicalSnapshot: HistoricalSnapshotWriteResult;
}): boolean {
  return (
    params.criticalSourceFailures.length > 0 ||
    !params.analysis.previousCoverageBaselineAvailable ||
    params.analysis.nearCoverageGuard ||
    params.analysis.nearValueGuard ||
    params.analysis.nearMajorCoverageGuard ||
    params.persistence.orphanCleanupFailed ||
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
    }>;
  };
  sourceCoverage: DexLiquidityPostScoreAnalysis["sourceCoverage"];
  challengerPublication: {
    publishedStablecoins: number;
    skippedStablecoins: number;
    missingTables: boolean;
  };
  failedSources: string[];
  fallbackSignals: string[];
  persistence: PersistScoresResult;
  historicalSnapshot: HistoricalSnapshotWriteResult;
}): Record<string, unknown> {
  return {
    rowsRead: params.rowsRead,
    rowsWritten: params.rowsWritten,
    rowsDropped: 0,
    stagedPoolsMerged: params.stagedPoolsMerged,
    stagedPoolsSkipped: params.stagedPoolsSkipped,
    stagedPoolsSkippedByExactIdentity: params.stagedPoolsSkippedByExactIdentity,
    stagedPoolsSkippedByUniqueDerivedIdentity: params.stagedPoolsSkippedByUniqueDerivedIdentity,
    stagedPoolsSkippedByOptionalWildcardIdentity: params.stagedPoolsSkippedByOptionalWildcardIdentity,
    stagedPoolsSkippedByAuthoritativeProtocol: params.stagedPoolsSkippedByAuthoritativeProtocol,
    stagedPoolSkipDimensions: params.stagedPoolSkipDimensions,
    directApiSourceSummary: params.directApiSourceSummary,
    sourceCoverage: {
      ...params.sourceCoverage,
      challengerSnapshotsPublished: params.challengerPublication.publishedStablecoins,
      challengerSnapshotsSkipped: params.challengerPublication.skippedStablecoins,
      challengerSnapshotTablesMissing: params.challengerPublication.missingTables,
    },
    failedSources: [...new Set(params.failedSources)],
    fallbackMode: [...new Set(params.fallbackSignals)],
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
      skipped: params.persistence.skipped ?? false,
      skippedReason: params.persistence.skippedReason ?? null,
      historicalSnapshotRowsWritten: params.historicalSnapshot.snapshotRowsWritten,
      historicalSnapshotSkipped: params.historicalSnapshot.skipped,
      historicalSnapshotWriteFailed: params.historicalSnapshot.writeFailed,
      historicalSnapshotRowsPruned: params.historicalSnapshot.historyRowsPruned,
      historicalSnapshotRetentionPruneFailed: params.historicalSnapshot.retentionPruneFailed,
    },
    validationFailures: 0,
  };
}
