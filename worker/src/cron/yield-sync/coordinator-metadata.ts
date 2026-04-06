import type { YieldBenchmarkMeta, YieldSafetySnapshotMeta, YieldSourceInputMeta } from "@shared/types/yield";
import { shouldDegradeForRiskFreeRate } from "./evaluation";
import type { YieldSupplementalCacheMeta } from "./state-loading";

export function buildYieldSafetySnapshotMeta(input: {
  kind: "ok" | "degraded";
  coverageRatio: number;
  coveredCount: number;
  trackedCount: number;
  reason: string | null;
}): YieldSafetySnapshotMeta {
  return {
    kind: input.kind,
    coverageRatio: Number(input.coverageRatio.toFixed(4)),
    coveredCount: input.coveredCount,
    trackedCount: input.trackedCount,
    reason: input.reason,
  };
}

export function buildYieldDegradationReasons(params: {
  safetySnapshotDegraded: boolean;
  safetySnapshotReason: string | null;
  riskFreeRateMeta: YieldBenchmarkMeta;
  dlPoolsMeta: YieldSourceInputMeta;
  allDeterministicFailed: boolean;
  maskedAllDeterministicFailure: boolean;
  onChainSkippedDueToCooldown: boolean;
  onChainAlternativeCoverageMissingIds: string[];
}): string[] {
  const degradationReasons: string[] = [];

  if (params.safetySnapshotDegraded) {
    degradationReasons.push("safety-snapshot-coverage");
    if (params.safetySnapshotReason) {
      degradationReasons.push(`safety-snapshot:${params.safetySnapshotReason}`);
    }
  }
  if (shouldDegradeForRiskFreeRate(params.riskFreeRateMeta)) {
    degradationReasons.push(`risk-free-rate:${params.riskFreeRateMeta.fallbackMode}`);
  }
  if (params.dlPoolsMeta.mode === "unavailable" || params.dlPoolsMeta.fallbackMode === "cache-parse-failed") {
    degradationReasons.push(`dl-pools:${params.dlPoolsMeta.fallbackMode ?? params.dlPoolsMeta.mode}`);
  }
  if (params.allDeterministicFailed && !params.maskedAllDeterministicFailure) {
    degradationReasons.push("onchain-rates:all-deterministic-failed");
  }
  if (params.onChainSkippedDueToCooldown && params.onChainAlternativeCoverageMissingIds.length > 0) {
    degradationReasons.push("onchain-rates:cooldown-coverage-gap");
  }

  return degradationReasons;
}

export function buildYieldSyncMetadata(input: {
  rowsRead: number;
  rowsWritten: number;
  rowsRejected: number;
  divergenceFlags: number;
  sourceSwitches: number;
  defaultSafetyCoinCount: number;
  safetySnapshot: YieldSafetySnapshotMeta;
  resolvedYieldBearingCount: number;
  expectedYieldBearingCount: number;
  publishedYieldBearingCount: number;
  previousPublishedYieldBearingCount: number;
  dlPoolsMeta: YieldSourceInputMeta;
  supplementalMeta: YieldSupplementalCacheMeta;
  onChainRatesResolved: number;
  onChainRatesConfigured: number;
  onChainAttempted: number;
  onChainAllDeterministicFailed: boolean;
  onChainExplorerAttempted: number;
  onChainExplorerResolved: number;
  onChainFailureMaskedByAlternativeCoverage: boolean;
  onChainAlternativeCoverageMissingIds: string[];
  onChainFailures: Record<string, number> | null;
  onChainSkippedDueToCooldown: boolean;
  onChainCooldownActive: boolean;
  onChainCooldownTriggered: boolean;
  onChainCooldownUntil: number | null;
  onChainCooldownRemainingSec: number;
  onChainConsecutiveAllFailRuns: number;
  onChainConsecutiveMaskedAllFailRuns: number;
  fallbackMode: string | null;
  validationFailures: number;
  riskFreeRate: number;
  cacheWriteSkipped: boolean;
}): string {
  return JSON.stringify({
    rowsRead: input.rowsRead,
    rowsWritten: input.rowsWritten,
    rowsDropped: input.rowsRejected,
    rowsRejected: input.rowsRejected,
    divergenceFlags: input.divergenceFlags,
    sourceSwitches: input.sourceSwitches,
    defaultSafetyCoinCount: input.defaultSafetyCoinCount,
    sourceCoverage: {
      safetyScoresComputed: input.safetySnapshot.coveredCount,
      safetyScoresExpected: input.safetySnapshot.trackedCount,
      safetyCoverageRatio: input.safetySnapshot.coverageRatio,
      resolvedYieldBearingCount: input.resolvedYieldBearingCount,
      expectedYieldBearingCount: input.expectedYieldBearingCount,
      publishedYieldBearingCount: input.publishedYieldBearingCount,
      previousPublishedYieldBearingCount: input.previousPublishedYieldBearingCount,
      dlPoolCount: input.dlPoolsMeta.poolCount,
      supplementalSourceMode: input.supplementalMeta.mode,
      supplementalSourceUpdatedAt: input.supplementalMeta.updatedAt,
      supplementalSourceAgeSeconds: input.supplementalMeta.ageSeconds,
      supplementalSourceCount: input.supplementalMeta.sourceCount,
      onChainRatesResolved: input.onChainRatesResolved,
      onChainRatesConfigured: input.onChainRatesConfigured,
      onChainAttempted: input.onChainAttempted,
      onChainAllDeterministicFailed: input.onChainAllDeterministicFailed,
      onChainExplorerAttempted: input.onChainExplorerAttempted,
      onChainExplorerResolved: input.onChainExplorerResolved,
      onChainFailureMaskedByAlternativeCoverage: input.onChainFailureMaskedByAlternativeCoverage,
      onChainAlternativeCoverageMissingIds: input.onChainAlternativeCoverageMissingIds,
      onChainFailures: input.onChainFailures,
      onChainSkippedDueToCooldown: input.onChainSkippedDueToCooldown,
      onChainCooldownActive: input.onChainCooldownActive,
      onChainCooldownTriggered: input.onChainCooldownTriggered,
      onChainCooldownUntil: input.onChainCooldownUntil,
      onChainCooldownRemainingSec: input.onChainCooldownRemainingSec,
      onChainConsecutiveAllFailRuns: input.onChainConsecutiveAllFailRuns,
      onChainConsecutiveMaskedAllFailRuns: input.onChainConsecutiveMaskedAllFailRuns,
    },
    fallbackMode: input.fallbackMode,
    validationFailures: input.validationFailures,
    riskFreeRate: input.riskFreeRate,
    cacheWriteSkipped: input.cacheWriteSkipped,
  });
}
