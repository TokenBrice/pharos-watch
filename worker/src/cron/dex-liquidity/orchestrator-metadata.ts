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
    params.historicalSnapshot.writeFailed
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
    sourceCoverage: {
      ...params.sourceCoverage,
      challengerSnapshotsPublished: params.challengerPublication.publishedStablecoins,
      challengerSnapshotsSkipped: params.challengerPublication.skippedStablecoins,
      challengerSnapshotTablesMissing: params.challengerPublication.missingTables,
    },
    failedSources: [...new Set(params.failedSources)],
    fallbackMode: [...new Set(params.fallbackSignals)],
    persistence: {
      placeholderRowsWritten: params.persistence.placeholderCount,
      orphanRowsDeleted: params.persistence.orphanRowsDeleted,
      orphanCleanupFailed: params.persistence.orphanCleanupFailed,
      skipped: params.persistence.skipped ?? false,
      skippedReason: params.persistence.skippedReason ?? null,
      historicalSnapshotRowsWritten: params.historicalSnapshot.snapshotRowsWritten,
      historicalSnapshotSkipped: params.historicalSnapshot.skipped,
      historicalSnapshotWriteFailed: params.historicalSnapshot.writeFailed,
    },
    validationFailures: 0,
  };
}
