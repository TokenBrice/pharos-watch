import type { YieldBenchmarkMeta, YieldSafetySnapshotMeta, YieldSourceInputMeta } from "@shared/types/yield";
import type { SafetyScorePublicationIdentity } from "@shared/types/safety-score-publication";
import type { EvaluatedYieldSource } from "./evaluation-types";
import { classifyYieldBenchmarkFreshness } from "./benchmarks";
import type { YieldEnvelopeRejection } from "./types";
import type { YieldSupplementalCacheMeta } from "./state-loading";
import { getComparisonAnchorStaleThresholdMs } from "../yield-helpers";

const YIELD_METADATA_EXAMPLE_LIMIT = 25;

export interface YieldComparisonAnchorFreshnessMeta {
  anchoredRowCount: number;
  staleAnchorCount: number;
  oldestAnchorAgeSeconds: number | null;
  oldestAnchorStablecoinId: string | null;
  oldestAnchorSourceKey: string | null;
  staleAnchorExamples: Array<{
    stablecoinId: string;
    symbol: string;
    sourceKey: string;
    dataSource: string;
    anchorAgeSeconds: number;
    maxAgeSeconds: number;
    comparisonAnchorObservedAt: number;
  }>;
  staleAnchorExamplesTruncated: boolean;
}

export function buildComparisonAnchorFreshnessMeta(input: {
  evaluatedSources: readonly EvaluatedYieldSource[];
  startSec: number;
}): YieldComparisonAnchorFreshnessMeta {
  const anchorRows = input.evaluatedSources
    .flatMap((source) => {
      if (source.comparisonAnchorObservedAt == null) return [];
      const anchorAgeSeconds = Math.max(0, input.startSec - source.comparisonAnchorObservedAt);
      const maxAgeSeconds = Math.floor(
        getComparisonAnchorStaleThresholdMs(source.dataSource, source.sourceKey) / 1000,
      );
      return [
        {
          stablecoinId: source.id,
          symbol: source.symbol,
          sourceKey: source.sourceKey,
          dataSource: source.dataSource,
          anchorAgeSeconds,
          maxAgeSeconds,
          comparisonAnchorObservedAt: source.comparisonAnchorObservedAt,
        },
      ];
    })
    .sort((a, b) => b.anchorAgeSeconds - a.anchorAgeSeconds);

  const staleAnchorRows = anchorRows.filter((row) => row.anchorAgeSeconds > row.maxAgeSeconds);
  const oldest = anchorRows[0] ?? null;

  return {
    anchoredRowCount: anchorRows.length,
    staleAnchorCount: staleAnchorRows.length,
    oldestAnchorAgeSeconds: oldest?.anchorAgeSeconds ?? null,
    oldestAnchorStablecoinId: oldest?.stablecoinId ?? null,
    oldestAnchorSourceKey: oldest?.sourceKey ?? null,
    staleAnchorExamples: staleAnchorRows.slice(0, YIELD_METADATA_EXAMPLE_LIMIT),
    staleAnchorExamplesTruncated: staleAnchorRows.length > YIELD_METADATA_EXAMPLE_LIMIT,
  };
}

export function buildYieldSafetySnapshotMeta(input: {
  kind: "ok" | "degraded";
  coverageRatio: number;
  coveredCount: number;
  trackedCount: number;
  reason: string | null;
  source: "safety-score-v9-publication";
  expectedModel: "v9";
  safetyScoreIdentity: SafetyScorePublicationIdentity | null;
  publicationGenerationId: string | null;
  methodologyVersion: string | null;
  publishedAt: number | null;
}): YieldSafetySnapshotMeta {
  return {
    kind: input.kind,
    coverageRatio: Number(input.coverageRatio.toFixed(4)),
    coveredCount: input.coveredCount,
    trackedCount: input.trackedCount,
    reason: input.reason,
    source: input.source,
    expectedModel: input.expectedModel,
    safetyScoreIdentity: input.safetyScoreIdentity,
    publicationGenerationId: input.publicationGenerationId,
    methodologyVersion: input.methodologyVersion,
    publishedAt: input.publishedAt,
  };
}

export function buildYieldDegradationReasons(params: {
  safetySnapshotDegraded: boolean;
  safetySnapshotReason: string | null;
  defaultBenchmarkMeta: YieldBenchmarkMeta;
  selectedSources: readonly EvaluatedYieldSource[];
  dlPoolsMeta: YieldSourceInputMeta;
  allDeterministicFailed: boolean;
  maskedAllDeterministicFailure: boolean;
  onChainSkippedDueToCooldown: boolean;
  onChainAlternativeCoverageMissingIds: string[];
  previousTvlRowsTruncated: boolean;
}): string[] {
  const degradationReasons: string[] = [];

  if (params.safetySnapshotDegraded) {
    degradationReasons.push("safety-snapshot-coverage");
    if (params.safetySnapshotReason) {
      degradationReasons.push(`safety-snapshot:${params.safetySnapshotReason}`);
    }
  }
  const defaultBenchmarkFreshness = classifyYieldBenchmarkFreshness(params.defaultBenchmarkMeta);
  if (defaultBenchmarkFreshness !== "healthy") {
    degradationReasons.push(
      `risk-free-rate:${params.defaultBenchmarkMeta.fallbackMode ?? defaultBenchmarkFreshness}`,
    );
  }
  const benchmarkByKey = new Map(
    params.selectedSources
      .filter((source) => source.benchmarkKey !== "USD")
      .map((source) => [source.benchmarkKey, source] as const),
  );
  for (const [key, source] of benchmarkByKey) {
    if (source.benchmarkFreshness === "healthy") continue;
    const reason = source.benchmarkFallbackMode ?? source.benchmarkFreshness;
    degradationReasons.push(
      key === "USD"
        ? `risk-free-rate:${reason}`
        : `risk-free-rate:${key}:${reason}`,
    );
  }
  if (params.selectedSources.some((source) => source.sourceFreshness === "stale")) {
    degradationReasons.push("yield-source:expired-selected");
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
  if (params.previousTvlRowsTruncated) {
    degradationReasons.push("yield-history:previous-tvl-row-cap");
  }

  return degradationReasons;
}

/**
 * On-chain rate health, coverage, and cooldown telemetry. These fields travel
 * together as a cohesive unit through the yield-sync coordinator, so they are
 * grouped into a sub-object rather than flattened onto the metadata signature.
 */
export interface YieldOnChainSyncMeta {
  ratesResolved: number;
  ratesConfigured: number;
  envelopeRejections: readonly YieldEnvelopeRejection[];
  attempted: number;
  allDeterministicFailed: boolean;
  explorerAttempted: number;
  explorerResolved: number;
  failureMaskedByAlternativeCoverage: boolean;
  alternativeCoverageMissingIds: string[];
  failures: Record<string, number> | null;
  skippedDueToCooldown: boolean;
  cooldownActive: boolean;
  cooldownTriggered: boolean;
  cooldownUntil: number | null;
  cooldownRemainingSec: number;
  consecutiveAllFailRuns: number;
  consecutiveMaskedAllFailRuns: number;
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
  publishedOpportunityCount: number;
  previousPublishedOpportunityCount: number;
  publishedRankingCount: number;
  previousPublishedRankingCount: number;
  dlPoolsMeta: YieldSourceInputMeta;
  supplementalMeta: YieldSupplementalCacheMeta;
  onChain: YieldOnChainSyncMeta;
  fallbackMode: string | null;
  validationFailures: number;
  riskFreeRate: number;
  cacheWriteSkipped: boolean;
  comparisonAnchorFreshness: YieldComparisonAnchorFreshnessMeta;
  previousTvlRowsTruncated: boolean;
}): string {
  const onChain = input.onChain;
  const onChainEnvelopeRejections = onChain.envelopeRejections.slice(0, YIELD_METADATA_EXAMPLE_LIMIT);
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
      safetySnapshot: input.safetySnapshot,
      resolvedYieldBearingCount: input.resolvedYieldBearingCount,
      expectedYieldBearingCount: input.expectedYieldBearingCount,
      publishedYieldBearingCount: input.publishedYieldBearingCount,
      previousPublishedYieldBearingCount: input.previousPublishedYieldBearingCount,
      publishedOpportunityCount: input.publishedOpportunityCount,
      previousPublishedOpportunityCount: input.previousPublishedOpportunityCount,
      publishedRankingCount: input.publishedRankingCount,
      previousPublishedRankingCount: input.previousPublishedRankingCount,
      publishedRankingCountDelta: input.publishedRankingCount - input.previousPublishedRankingCount,
      dlPoolCount: input.dlPoolsMeta.poolCount,
      supplementalSourceMode: input.supplementalMeta.mode,
      supplementalSourceUpdatedAt: input.supplementalMeta.updatedAt,
      supplementalSourceAgeSeconds: input.supplementalMeta.ageSeconds,
      supplementalSourceCount: input.supplementalMeta.sourceCount,
      supplementalFallbackMode: input.supplementalMeta.fallbackMode,
      onChainRatesResolved: onChain.ratesResolved,
      onChainRatesConfigured: onChain.ratesConfigured,
      onChainEnvelopeRejectionCount: onChain.envelopeRejections.length,
      onChainEnvelopeRejections,
      onChainEnvelopeRejectionsTruncated: onChain.envelopeRejections.length > YIELD_METADATA_EXAMPLE_LIMIT,
      onChainAttempted: onChain.attempted,
      onChainAllDeterministicFailed: onChain.allDeterministicFailed,
      onChainExplorerAttempted: onChain.explorerAttempted,
      onChainExplorerResolved: onChain.explorerResolved,
      onChainFailureMaskedByAlternativeCoverage: onChain.failureMaskedByAlternativeCoverage,
      onChainAlternativeCoverageMissingIds: onChain.alternativeCoverageMissingIds,
      onChainFailures: onChain.failures,
      onChainSkippedDueToCooldown: onChain.skippedDueToCooldown,
      onChainCooldownActive: onChain.cooldownActive,
      onChainCooldownTriggered: onChain.cooldownTriggered,
      onChainCooldownUntil: onChain.cooldownUntil,
      onChainCooldownRemainingSec: onChain.cooldownRemainingSec,
      onChainConsecutiveAllFailRuns: onChain.consecutiveAllFailRuns,
      onChainConsecutiveMaskedAllFailRuns: onChain.consecutiveMaskedAllFailRuns,
      comparisonAnchorFreshness: input.comparisonAnchorFreshness,
      previousTvlRowsTruncated: input.previousTvlRowsTruncated,
    },
    fallbackMode: input.fallbackMode,
    validationFailures: input.validationFailures,
    riskFreeRate: input.riskFreeRate,
    cacheWriteSkipped: input.cacheWriteSkipped,
  });
}
