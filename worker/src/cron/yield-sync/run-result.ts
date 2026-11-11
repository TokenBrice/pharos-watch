import type { YieldSafetySnapshotMeta, YieldSourceInputMeta } from "@shared/types/yield";
import type { SafetyScorePublicationIdentity } from "@shared/types/safety-score-publication";
import { YIELD_SAFETY_STALE_COHERENT_MAX_AGE_SEC } from "@shared/lib/yield-safety-fallback";
import type { EvaluatedYieldSource } from "./evaluation";
import type { YieldEnvelopeRejection } from "./types";
import type { StablecoinSupplyMapState, YieldSupplementalCacheMeta } from "./state";
import type { YieldOptionalSourceOutcome } from "./sources-rpc";
import type { YieldRowsWriteStats } from "./publication-storage";
import { getComparisonAnchorStaleThresholdMs } from "../../lib/yield-ranking-helpers";
import { YIELD_OPPORTUNITY_EXCLUSIONS } from "../../lib/yield-config/yield-opportunity-exclusions";

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
  coverageRatio: number | null;
  coveredCount: number;
  trackedCount: number | null;
  reason: string | null;
  source: "safety-score-v9-publication";
  safetyScoreIdentity: SafetyScorePublicationIdentity | null;
  publicationGenerationId: string | null;
  methodologyVersion: string | null;
  publishedAt: number | null;
}): YieldSafetySnapshotMeta {
  return {
    kind: input.kind,
    coverageRatio: input.coverageRatio == null ? null : Number(input.coverageRatio.toFixed(4)),
    coveredCount: input.coveredCount,
    trackedCount: input.trackedCount,
    reason: input.reason,
    source: input.source,
    safetyScoreIdentity: input.safetyScoreIdentity,
    publicationGenerationId: input.publicationGenerationId,
    methodologyVersion: input.methodologyVersion,
    publishedAt: input.publishedAt,
    maxAgeSeconds: YIELD_SAFETY_STALE_COHERENT_MAX_AGE_SEC,
  };
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
  cooldownTriggered: boolean;
  cooldownUntil: number | null;
  cooldownRemainingSec: number;
  consecutiveAllFailRuns: number;
  consecutiveMaskedAllFailRuns: number;
}

export interface YieldSafetyIdentityChangeMeta {
  reason: "yield-safety-identity-changed-before-publish";
  loadedPublicationGenerationId: string;
  currentPublicationGenerationId: string;
  loadedEvaluationBuildDigest: string;
  currentEvaluationBuildDigest: string;
}

export function buildYieldSyncMetadata(input: {
  startSec: number;
  rowsRead: number;
  rowsWritten: number;
  rowsRejected: number;
  divergenceFlags: number;
  sourceSwitches: number;
  defaultSafetyCoinCount: number;
  safetySnapshot: YieldSafetySnapshotMeta;
  safetySnapshotHeld: boolean;
  resolvedYieldBearingCount: number;
  expectedYieldBearingCount: number;
  publishedYieldBearingCount: number;
  previousPublishedYieldBearingCount: number | null;
  publishedOpportunityCount: number;
  previousPublishedOpportunityCount: number | null;
  publishedRankingCount: number;
  previousPublishedRankingCount: number | null;
  dlPoolsMeta: YieldSourceInputMeta;
  /** SRC-SUPP-3: DL pool rows dropped by the APY envelope during this run's load. */
  dlApyEnvelopeRejectedCount: number;
  supplementalMeta: YieldSupplementalCacheMeta;
  stablecoinSupplyMapState: StablecoinSupplyMapState;
  /** B15 optional-family failures: reported here, never as a degradation reason. */
  optionalSourceFailures: readonly YieldOptionalSourceOutcome[];
  onChain: YieldOnChainSyncMeta;
  qualityReasons: string[];
  reason?: string;
  validationFailures: number;
  riskFreeRate: number;
  cacheWriteSkipped: boolean;
  comparisonAnchorFreshness: YieldComparisonAnchorFreshnessMeta;
  previousTvlRowsTruncated: boolean;
  /** Atomic publication payload sizes and `pys_inputs_at_publish` null rate. */
  publicationStats: YieldRowsWriteStats | null;
  safetyIdentityChangedBeforePublish?: YieldSafetyIdentityChangeMeta | null;
}): string {
  const onChain = input.onChain;
  const qualityReasons = [
    ...input.qualityReasons,
    ...YIELD_OPPORTUNITY_EXCLUSIONS
      .filter((entry) => Date.parse(`${entry.nextReviewAt}T00:00:00Z`) <= input.startSec * 1000)
      .map((entry) => `yield-opportunity-exclusion-review-due:${entry.projects[0]}`),
  ];
  const onChainEnvelopeRejections = onChain.envelopeRejections.slice(0, YIELD_METADATA_EXAMPLE_LIMIT);
  const advisoryReasons: string[] = [];
  if (input.safetySnapshotHeld) advisoryReasons.push("safety-snapshot-held");
  if (input.supplementalMeta.degradedFamilies.includes("pendle")) {
    const reason = input.supplementalMeta.degradedFamilyReasons?.pendle;
    advisoryReasons.push(`yield-supplemental:family-degraded:pendle${reason ? `:${reason}` : ""}`);
  }
  if (input.supplementalMeta.unavailableRequiredFamilies?.includes("pendle")) {
    advisoryReasons.push("yield-supplemental:family-unavailable:pendle");
  }
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
      publishedRankingCountDelta: input.previousPublishedRankingCount == null
        ? null
        : input.publishedRankingCount - input.previousPublishedRankingCount,
      dlPoolCount: input.dlPoolsMeta.poolCount,
      dlApyEnvelopeRejectedCount: input.dlApyEnvelopeRejectedCount,
      supplementalSourceMode: input.supplementalMeta.mode,
      supplementalSourceUpdatedAt: input.supplementalMeta.updatedAt,
      supplementalSourceAgeSeconds: input.supplementalMeta.ageSeconds,
      supplementalSourceCount: input.supplementalMeta.sourceCount,
      supplementalFallbackMode: input.supplementalMeta.fallbackMode,
      supplementalUnknownOutcomeFamilies: input.supplementalMeta.unknownOutcomeFamilies ?? [],
      stablecoinSupplyMapState: input.stablecoinSupplyMapState,
      optionalSourceFailures: input.optionalSourceFailures,
      optionalSourceFailureCount: input.optionalSourceFailures.length,
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
      onChainCooldownActive: onChain.skippedDueToCooldown,
      onChainCooldownTriggered: onChain.cooldownTriggered,
      onChainCooldownUntil: onChain.cooldownUntil,
      onChainCooldownRemainingSec: onChain.cooldownRemainingSec,
      onChainConsecutiveAllFailRuns: onChain.consecutiveAllFailRuns,
      onChainConsecutiveMaskedAllFailRuns: onChain.consecutiveMaskedAllFailRuns,
      comparisonAnchorFreshness: input.comparisonAnchorFreshness,
      previousTvlRowsTruncated: input.previousTvlRowsTruncated,
    },
    quality: { degraded: qualityReasons.length > 0, reasons: qualityReasons, advisoryReasons },
    ...(input.reason ? { reason: input.reason } : {}),
    validationFailures: input.validationFailures,
    riskFreeRate: input.riskFreeRate,
    cacheWriteSkipped: input.cacheWriteSkipped,
    ...(input.publicationStats ? { publicationStats: input.publicationStats } : {}),
    ...(input.safetyIdentityChangedBeforePublish
      ? { safetyIdentityChangedBeforePublish: input.safetyIdentityChangedBeforePublish }
      : {}),
  });
}

