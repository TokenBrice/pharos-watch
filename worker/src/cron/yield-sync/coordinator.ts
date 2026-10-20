import type {
  YieldBenchmarkMeta,
  YieldSafetySnapshotMeta,
  YieldSourceInputMeta,
} from "@shared/types/yield";
import type {
  SafetyScorePublicationIdentity,
} from "@shared/types/safety-score-publication";
import {
  type EvaluatedYieldSource,
  evaluateYieldSourcesCooperative,
} from "./evaluation";
import {
  classifyYieldBenchmarkFreshness,
} from "@shared/lib/yield-benchmark-freshness";
import type {
  YieldEnvelopeRejection,
} from "./types";
import {
  type StablecoinSupplyMapState,
  type YieldSupplementalCacheMeta,
  loadYieldSyncState,
  buildNextDeterministicOnChainHealthState,
  persistDeterministicOnChainHealthState,
} from "./state";
import type {
  YieldOptionalSourceOutcome,
} from "./sources-rpc";
import {
  type YieldRowsWriteStats,
  repairPublishedYieldGenerationFromCache,
  buildPreviewYieldRankingsArtifacts,
  loadPreviousYieldPublicationSnapshot,
  derivePreviousYieldRankingsCount,
  type PreviousYieldPublicationRanking,
  type PreviousYieldPublicationSnapshot,
  publishYieldCoordinatorResults,
} from "./publication";
import {
  getComparisonAnchorStaleThresholdMs,
} from "../../lib/yield-ranking-helpers";
import {
  REQUIRED_SUPPLEMENTAL_SOURCE_FAMILY_KEYS,
} from "./family-registry";
import {
  STATUS_YIELD_HEALTH_THRESHOLDS,
} from "@shared/lib/status-thresholds";
import {
  YIELD_SAFETY_STALE_COHERENT_MAX_AGE_SEC,
} from "@shared/lib/yield-safety-fallback";
import type {
  ChainRpcConfig,
} from "../../lib/chain-registry";
import {
  buildYieldHistoryEvaluationInputsCooperative,
  loadYieldHistorySnapshots,
} from "./history";
import {
  resolveYieldSources,
} from "./resolve";
import {
  ACTIVE_YIELD_BEARING_STABLECOINS,
} from "@shared/lib/tracked-stablecoin-utils";
import {
  ACTIVE_STABLECOINS,
} from "@shared/lib/stablecoins/registry";
import {
  DAY_SECONDS,
} from "@shared/lib/time-constants";
import type {
  CronProgressReporter,
  CronResult,
} from "../../lib/cron-logger";
import {
  createCronResult,
  type CronMetadataRecord,
} from "../../lib/cron-result";
import {
  getCache,
} from "../../lib/db-cache";
import {
  logWorkerEvent,
  logWorkerEventArgs,
} from "../../lib/structured-log";
import {
  YIELD_HISTORY_CLEANUP_WRITER_PAUSE_KEY,
  parseYieldHistoryWriterPause,
} from "../../lib/yield-history-cleanup";
import {
  ON_CHAIN_RATE_CONFIGS,
} from "../../lib/yield-config/yield-config";
import {
  createYieldProgressReporter,
} from "../yield-progress";
import {
  safetyScorePublicationIdentitiesAreComparable,
} from "@shared/lib/safety-score-publication";
import {
  loadActiveSafetyScoreIdentity,
} from "../../lib/safety-score-active-source";

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

export function buildYieldDegradationReasons(params: {
  safetyCoverageRatio: number | null;
  defaultBenchmarkMeta: YieldBenchmarkMeta;
  riskFreeRateRegistryCacheState?: string;
  selectedSources: readonly EvaluatedYieldSource[];
  dlPoolsMeta: YieldSourceInputMeta;
  supplementalMeta: YieldSupplementalCacheMeta;
  stablecoinSupplyMapState: StablecoinSupplyMapState;
  allDeterministicFailed: boolean;
  maskedAllDeterministicFailure: boolean;
  onChainSkippedDueToCooldown: boolean;
  onChainAlternativeCoverageMissingIds: string[];
  previousTvlRowsTruncated: boolean;
}): string[] {
  const degradationReasons: string[] = [];
  // All-rejected arbitration retains a diagnostic winner, never a public row.
  const selectedSources = params.selectedSources.filter((source) => !source.rejected);

  if (params.safetyCoverageRatio == null) {
    degradationReasons.push("safety-snapshot-unavailable");
  } else if (params.safetyCoverageRatio < STATUS_YIELD_HEALTH_THRESHOLDS.safetyCoverageRatio) {
    degradationReasons.push("safety-snapshot-coverage");
  }
  if (params.riskFreeRateRegistryCacheState === "invalid") {
    degradationReasons.push("yield-benchmarks:registry-invalid");
  }
  const defaultBenchmarkFreshness = classifyYieldBenchmarkFreshness(params.defaultBenchmarkMeta);
  if (defaultBenchmarkFreshness !== "healthy") {
    degradationReasons.push(
      `risk-free-rate:${params.defaultBenchmarkMeta.fallbackMode ?? defaultBenchmarkFreshness}`,
    );
  }
  const benchmarkByKey = new Map(
    selectedSources
      .filter((source) => source.benchmarkKey !== "USD")
      .map((source) => [source.benchmarkKey, source] as const),
  );
  for (const [key, source] of benchmarkByKey) {
    if (source.benchmarkFreshness === "healthy") continue;
    const reason = source.benchmarkFallbackMode ?? source.benchmarkFreshness;
    degradationReasons.push(`risk-free-rate:${key}:${reason}`);
  }
  const staleSelectedSource = selectedSources.find((source) => source.sourceFreshness === "stale");
  if (staleSelectedSource) {
    degradationReasons.push(`yield-source:expired-selected:${staleSelectedSource.sourceKey}`);
  }
  if (params.dlPoolsMeta.mode === "unavailable" || params.dlPoolsMeta.fallbackMode === "cache-parse-failed") {
    degradationReasons.push(`dl-pools:${params.dlPoolsMeta.fallbackMode ?? params.dlPoolsMeta.mode}`);
  }
  if (params.stablecoinSupplyMapState !== "ok") {
    degradationReasons.push(`yield-supply-map:${params.stablecoinSupplyMapState}`);
  }
  // The aggregate coverage floor (60%) cannot see the supplemental lane's share
  // of published rows, so its own cache state and retained-degraded families are
  // reported directly instead of waiting for the floor to trip.
  const supplemental = params.supplementalMeta;
  // The chained supplemental job (A4/C16) writes these family caches earlier in
  // the same slot, so `missing-cache` means the lane was never provisioned
  // rather than lost; the coverage guards own any actual published-row loss.
  // Every other required-lane state is input quality, not a failed publication.
  const supplementalLaneUnprovisioned =
    supplemental.fallbackMode === "missing-cache" && supplemental.sourceCount === 0;
  const pendleOnlyCacheLoss = supplemental.unavailableRequiredFamilies?.length === 1
    && supplemental.unavailableRequiredFamilies[0] === "pendle";
  if (supplemental.fallbackMode === "partial-family-cache" && !pendleOnlyCacheLoss) {
    degradationReasons.push("yield-supplemental:partial-family-cache");
  } else if (!supplementalLaneUnprovisioned && (supplemental.mode !== "cache" || supplemental.sourceCount === 0)) {
    degradationReasons.push(`yield-supplemental:${supplemental.fallbackMode ?? supplemental.mode}`);
  }
  for (const family of supplemental.degradedFamilies) {
    if (!REQUIRED_SUPPLEMENTAL_SOURCE_FAMILY_KEYS.some((key) => key === family)) continue;
    // The quota-bound daily Pendle lane is advisory; freshness tracks publication.
    // Its warning is retained separately in quality metadata.
    if (family === "pendle") continue;
    // Preserve the required family's concrete machine-readable failure cause.
    const familyReason = supplemental.degradedFamilyReasons?.[family];
    degradationReasons.push(
      familyReason
        ? `yield-supplemental:family-degraded:${family}:${familyReason}`
        : `yield-supplemental:family-degraded:${family}`,
    );
  }
  // B15 optional-family failures deliberately do not appear here: a coin whose
  // optional read failed still publishes from its other coverage, and the
  // tracked/published coverage guards already defer publication when a failure
  // leaves a coin with none. The failures stay observable through the run
  // metadata (`buildYieldSyncMetadata`) and the source-resolution progress row.
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
  previousPublishedYieldBearingCount: number;
  publishedOpportunityCount: number;
  previousPublishedOpportunityCount: number;
  publishedRankingCount: number;
  previousPublishedRankingCount: number;
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
      publishedRankingCountDelta: input.publishedRankingCount - input.previousPublishedRankingCount,
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
    quality: { degraded: input.qualityReasons.length > 0, reasons: input.qualityReasons, advisoryReasons },
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

export interface YieldCoordinatorNormalizeStageParams {
  db: D1Database;
  signal?: AbortSignal;
  chainRpcs?: Map<string, ChainRpcConfig>;
  coingeckoApiKey?: string | null;
  fetched: YieldCoordinatorFetchContext;
}

export async function runYieldCoordinatorNormalizeStage(params: YieldCoordinatorNormalizeStageParams) {
  const { fetched } = params;
  await fetched.reportYieldProgress("source-resolution", "Resolving yield source candidates", "yield", {
    itemsDone: 0,
    metadata: {
      providerFamilies: ["defillama-yields", "yield-supplemental", "on-chain-rates"],
      countTotals: {
        yieldBearingCoins: fetched.yieldCoins.length,
        opportunityCoins: fetched.opportunityCoinIdSet.size,
        totalTrackedForYield: fetched.progressTotal,
        dlPools: fetched.dlPools.length,
        supplementalCandidates: fetched.supplementalCandidates.length,
        onChainRatesResolved: fetched.onChainRates.size,
      },
    },
  });
  const optionalSourceFailures: YieldOptionalSourceOutcome[] = [];
  const { resolved, tier1PrevRates, envelopeRejections } = await resolveYieldSources({
    db: params.db,
    startSec: fetched.startSec,
    sevenDaysAgoSec: fetched.sevenDaysAgoSec,
    dlPools: fetched.dlPools,
    onChainRates: fetched.onChainRates,
    safetyScores: fetched.safetyScores,
    safetySnapshotAvailable: fetched.safetySnapshotAvailable,
    riskFreeRates: fetched.riskFreeRates,
    signal: params.signal,
    chainRpcs: params.chainRpcs,
    coingeckoApiKey: params.coingeckoApiKey,
    supplementalCandidates: fetched.supplementalCandidates,
    stablecoinSupplyById: fetched.stablecoinSupplyById,
    stablecoinSupplyMapState: fetched.stablecoinSupplyMapState,
    onOptionalSourceOutcome: (outcome) => {
      optionalSourceFailures.push(outcome);
    },
  });

  const resolvedWithYield = resolved.filter((entry) => entry.yield != null);
  const resolvedYieldBearingIds = new Set(
    resolvedWithYield.filter((entry) => fetched.yieldCoinIdSet.has(entry.id)).map((entry) => entry.id),
  );
  const resolvedIds = [...new Set(resolvedWithYield.map((entry) => entry.id))];
  await fetched.reportYieldProgress("source-resolution-complete", "Resolved yield source candidates", "yield", {
    itemsDone: resolvedWithYield.length,
    metadata: {
      providerFamilies: ["defillama-yields", "yield-supplemental", "on-chain-rates"],
      countTotals: {
        resolvedSources: resolvedWithYield.length,
        resolvedCoins: resolvedIds.length,
        resolvedYieldBearingCoins: resolvedYieldBearingIds.size,
        envelopeRejections: envelopeRejections.length,
        optionalSourceFailureCount: optionalSourceFailures.length,
      },
      optionalSourceFailures,
    },
  });

  const resolvedSourceKeysByCoin = new Map<string, Set<string>>();
  for (const entry of resolvedWithYield) {
    const resolvedYield = entry.yield;
    if (!resolvedYield) continue;
    const sourceKeySet = resolvedSourceKeysByCoin.get(entry.id) ?? new Set<string>();
    sourceKeySet.add(resolvedYield.sourceKey);
    resolvedSourceKeysByCoin.set(entry.id, sourceKeySet);
  }

  const historySnapshots =
    resolvedIds.length > 0
      ? await loadYieldHistorySnapshots(params.db, resolvedIds, fetched.startSec, fetched.sevenDaysAgoSec, {
          signal: params.signal,
          sourceKeysByStablecoin: resolvedSourceKeysByCoin,
          onProgress: async (progress) => {
            await fetched.reportYieldProgress(
              "history-loading",
              "Loading yield history snapshots",
              "yield-history",
              {
                itemsDone: progress.resolvedIdsDone,
                itemsTotal: progress.resolvedIdsTotal,
                metadata: {
                  countTotals: {
                    resolvedSources: resolvedWithYield.length,
                    resolvedCoins: resolvedIds.length,
                    historyRows: progress.historyRows,
                    previousTvlRows: progress.prevTvlRows,
                    previousBestRows: progress.prevBestRows,
                    previousTvlRowsTruncated: progress.previousTvlRowsTruncated,
                  },
                  chunksDone: progress.chunksDone,
                  chunksTotal: progress.chunksTotal,
                },
              },
            );
          },
        })
      : { historyRows: [], prevTvlRows: [], prevBestRows: [], previousTvlRowsTruncated: false };
  await fetched.reportYieldProgress("history-loaded", "Loaded yield history snapshots", "yield-history", {
    itemsDone: resolvedIds.length,
    itemsTotal: resolvedIds.length,
    metadata: {
      countTotals: {
        historyRows: historySnapshots.historyRows.length,
        previousTvlRows: historySnapshots.prevTvlRows.length,
        previousBestRows: historySnapshots.prevBestRows.length,
        previousTvlRowsTruncated: historySnapshots.previousTvlRowsTruncated,
      },
    },
  });
  const historyInputs = await buildYieldHistoryEvaluationInputsCooperative(historySnapshots, {
    signal: params.signal,
    onProgress: async (progress) => {
      await fetched.reportYieldProgress(
        "history-input-construction",
        "Preparing yield history evaluation inputs",
        "yield-history",
        {
          itemsDone: progress.rowsDone,
          itemsTotal: progress.rowsTotal,
          metadata: {
            phase: progress.phase,
            countTotals: {
              historyRows: historySnapshots.historyRows.length,
              previousTvlRows: historySnapshots.prevTvlRows.length,
              previousBestRows: historySnapshots.prevBestRows.length,
              previousTvlRowsTruncated: historySnapshots.previousTvlRowsTruncated,
            },
          },
        },
      );
    },
  });

  await fetched.reportYieldProgress("evaluation", "Evaluating best yield sources and source risk", "yield", {
    itemsDone: 0,
    metadata: { countTotals: { resolvedSources: resolvedWithYield.length, resolvedCoins: resolvedIds.length } },
  });
  const evaluation = await evaluateYieldSourcesCooperative(
    {
      resolved: resolvedWithYield,
      startSec: fetched.startSec,
      sevenDaysAgoSec: fetched.sevenDaysAgoSec,
      safetyScores: fetched.safetyScores,
      safetySnapshotAvailable: fetched.safetySnapshotAvailable,
      safetyScoreIdentity: fetched.safetySnapshot.safetyScoreIdentity,
      riskFreeRates: fetched.riskFreeRates,
      tier1PrevRates,
      ...historyInputs,
      stablecoinSupplyById: fetched.stablecoinSupplyById,
      dlPoolsMeta: fetched.dlPoolsMeta,
    },
    {
      signal: params.signal,
      onProgress: async (progress) => {
        await fetched.reportYieldProgress("evaluation", "Evaluating best yield sources and source risk", "yield", {
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
    },
  );
  await fetched.reportYieldProgress("evaluation-complete", "Completed yield source evaluation", "yield", {
    itemsDone: evaluation.evaluatedSources.length,
    metadata: {
      countTotals: {
        evaluatedSources: evaluation.evaluatedSources.length,
        bestSourceCoins: evaluation.bestSourceKeyByCoin.size,
        rowsRejected: evaluation.rowsRejected,
        divergenceFlags: evaluation.divergenceFlags,
        sourceSwitches: evaluation.sourceSwitches,
      },
    },
  });

  return {
    resolvedWithYield,
    resolvedYieldBearingIds,
    resolvedIds,
    envelopeRejections,
    optionalSourceFailures,
    historySnapshots,
    ...evaluation,
  };
}

export type YieldCoordinatorNormalizeContext = Awaited<ReturnType<typeof runYieldCoordinatorNormalizeStage>>;

export interface YieldCoordinatorFetchStageParams {
  db: D1Database;
  signal?: AbortSignal;
  chainRpcs?: Map<string, ChainRpcConfig>;
  etherscanApiKey?: string | null;
  reportProgress?: CronProgressReporter;
}

export async function runYieldCoordinatorFetchStage(params: YieldCoordinatorFetchStageParams) {
  const startSec = Math.floor(Date.now() / 1000);
  const sevenDaysAgoSec = startSec - 7 * DAY_SECONDS;
  const yieldCoins = ACTIVE_YIELD_BEARING_STABLECOINS;
  const yieldCoinIdSet = new Set(yieldCoins.map((coin) => coin.id));
  const opportunityCoinIdSet = new Set(
    ACTIVE_STABLECOINS.map((coin) => coin.id).filter((id) => !yieldCoinIdSet.has(id)),
  );
  const { progressTotal, reportYieldProgress } = createYieldProgressReporter(params.reportProgress, {
    yieldBearingCoins: yieldCoins.length,
    opportunityCoins: opportunityCoinIdSet.size,
  });

  await reportYieldProgress("preflight", "Preparing yield publication inputs", "yield", { itemsDone: 0 });
  if (yieldCoins.length === 0) {
    // An empty cohort publishes nothing while every downstream surface keeps
    // serving the previous generation, so this must not report a healthy run.
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      event: "yield-sync-no-yield-bearing-coins",
      job: "sync-yield-data",
      message: "Yield sync has no active yield-bearing coins; publication skipped",
    });
    return {
      ok: false as const,
      result: createCronResult({
        status: "degraded",
        itemCount: 0,
        productivity: { productive: false, reason: "no-yield-bearing-coins" },
        metadata: { reason: "no-yield-bearing-coins" },
      }),
    };
  }

  const writerPause = parseYieldHistoryWriterPause(
    await getCache(params.db, YIELD_HISTORY_CLEANUP_WRITER_PAUSE_KEY),
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
      ok: false as const,
      result: createCronResult({
        status: "degraded" as const,
        itemCount: 0,
        metadata: {
          reason: "yield-writer-paused",
          writerPaused: true,
          pauseReason: writerPause.reason,
          pauseOperator: writerPause.operator,
          pausedAt: writerPause.pausedAt,
        },
      }),
    };
  }

  await repairPublishedYieldGenerationFromCache(params.db, startSec).catch((error: unknown) => {
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      event: "yield-generation-repair-failed",
      job: "sync-yield-data",
      message: "Failed to repair published yield generation before history load",
      error,
    });
  });

  await reportYieldProgress(
    "state-loading",
    "Loading yield source state and safety snapshots",
    "yield-source-cache",
    {
      itemsDone: 0,
      metadata: {
        providerFamilies: [
          "defillama-yields",
          "yield-supplemental",
          "on-chain-rates",
          "risk-free-rates",
          "safety-scores",
        ],
      },
    },
  );
  const loadedState = await loadYieldSyncState({
    db: params.db,
    startSec,
    signal: params.signal,
    chainRpcs: params.chainRpcs,
    etherscanApiKey: params.etherscanApiKey,
  });
  const riskFreeRate = loadedState.riskFreeRateMeta.rate;
  await reportYieldProgress("state-loaded", "Loaded yield source state", "yield-source-cache", {
    itemsDone:
      loadedState.dlPools.length + loadedState.supplementalCandidates.length + loadedState.onChainRates.size,
    metadata: {
      providerFamilies: [
        "defillama-yields",
        "yield-supplemental",
        "on-chain-rates",
        "risk-free-rates",
        "safety-scores",
      ],
      countTotals: {
        yieldBearingCoins: yieldCoins.length,
        opportunityCoins: opportunityCoinIdSet.size,
        totalTrackedForYield: progressTotal,
        dlPools: loadedState.dlPools.length,
        supplementalCandidates: loadedState.supplementalCandidates.length,
        supplementalSourceCount: loadedState.supplementalMeta.sourceCount,
        onChainRatesResolved: loadedState.onChainRates.size,
        onChainRatesConfigured: ON_CHAIN_RATE_CONFIGS.length,
        safetyScoresComputed: loadedState.safetySnapshot.coveredCount,
        safetyScoresExpected: loadedState.safetySnapshot.trackedCount,
      },
      supplementalMode: loadedState.supplementalMeta.mode,
      supplementalFallbackMode: loadedState.supplementalMeta.fallbackMode,
      onChainCooldownActive: loadedState.onChainSkippedDueToCooldown,
      onChainCooldownRemainingSec: loadedState.onChainCooldownRemainingSec,
      safetySnapshotAvailable: loadedState.safetySnapshotAvailable,
      safetySnapshotHeld: loadedState.safetySnapshotHeld,
      acceptedSafetyPublicationAgeSeconds: loadedState.acceptedSafetyPublicationAgeSeconds,
    },
  });

  if (loadedState.safetySnapshotHeld) {
    // A hold rejects the newest V9 attempt, not the accepted ratings the public
    // report-card route keeps serving, so the run publishes against the accepted
    // generation inside the read path's stale-coherent budget and reports the
    // hold as an advisory instead of deferring.
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      event: "yield-safety-publication-held",
      job: "sync-yield-data",
      message: loadedState.safetySnapshotAvailable
        ? "Safety Score V9 publication is held; publishing against the accepted generation"
        : "Safety Score V9 publication is held past the accepted-generation budget; publication deferred",
      metadata: {
        reason: loadedState.safetySnapshot.reason ?? null,
        acceptedPublicationAgeSeconds: loadedState.acceptedSafetyPublicationAgeSeconds,
        acceptedPublicationWithinBudget: loadedState.safetySnapshotAvailable,
        coveredCount: loadedState.safetySnapshot.coveredCount,
        trackedCount: loadedState.safetySnapshot.trackedCount,
      },
    });
  }
  if (loadedState.safetySnapshotAvailable && loadedState.safetySnapshotDegraded) {
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      event: "yield-safety-coverage-degraded",
      job: "sync-yield-data",
      message: "Safety snapshot coverage degraded during yield input loading",
      metadata: {
        coveredCount: loadedState.safetySnapshot.coveredCount,
        trackedCount: loadedState.safetySnapshot.trackedCount,
        coverageRatio: loadedState.safetyCoverageRatio,
        reason: loadedState.safetySnapshot.reason ?? null,
      },
    });
  }

  // R2 / E-yield: an unusable published V9 snapshot is an input outage, not a
  // zero-coverage measurement. It forces `scoreQualification: "NR"` on every
  // evaluated row (`safetySnapshotUnavailable`), which drops every publication
  // view (B13) and makes the run's ranking set empty by construction — while the
  // tracked-coverage guard still passes, because resolution is unaffected. Runs
  // that continue therefore report the empty set as
  // `published-yield-coverage-regression` (blaming yield sources for a safety
  // outage) and, with no prior rankings baseline to trip that guard, would
  // publish the empty payload outright. Fail closed on the real cause before the
  // resolution, history, and evaluation passes: the previous published
  // generation is retained and the run names its upstream reason verbatim. A
  // held publication whose accepted generation is still inside the read path's
  // stale-coherent budget is not unusable, so it does not reach this branch.
  if (!loadedState.safetySnapshotAvailable) {
    const safetySnapshotReason =
      loadedState.safetySnapshotUnavailableReason ?? "safety-score-v9-publication:identity-missing";
    const reason = `safety-snapshot-unavailable:${safetySnapshotReason}`;
    await reportYieldProgress(
      "safety-snapshot-unavailable",
      "Yield publication deferred: no usable published safety snapshot",
      "yield",
      {
        itemsDone: 0,
        metadata: {
          reason: safetySnapshotReason,
          safetySnapshotSource: loadedState.safetySnapshot.source,
          safetyScoresComputed: loadedState.safetySnapshot.coveredCount,
          safetyScoresExpected: loadedState.safetySnapshot.trackedCount,
          safetySnapshotHeld: loadedState.safetySnapshotHeld,
          acceptedPublicationAgeSeconds: loadedState.acceptedSafetyPublicationAgeSeconds,
        },
      },
    );
    return {
      ok: false as const,
      result: createCronResult({
        status: "degraded" as const,
        itemCount: 0,
        productivity: { productive: false, reason: "safety-snapshot-unavailable" },
        metadata: {
          reason,
          safetySnapshotSource: loadedState.safetySnapshot.source,
          safetyScoresComputed: loadedState.safetySnapshot.coveredCount,
          safetyScoresExpected: loadedState.safetySnapshot.trackedCount,
          safetyScoreIdentity: loadedState.safetySnapshot.safetyScoreIdentity,
          safetySnapshotHeld: loadedState.safetySnapshotHeld,
          safetyPublishedAt: loadedState.safetySnapshot.publishedAt,
          acceptedPublicationAgeSeconds: loadedState.acceptedSafetyPublicationAgeSeconds,
        },
      }),
    };
  }

  return {
    ok: true as const,
    context: {
      startSec,
      sevenDaysAgoSec,
      yieldCoins,
      yieldCoinIdSet,
      opportunityCoinIdSet,
      progressTotal,
      reportYieldProgress,
      riskFreeRate,
      ...loadedState,
    },
  };
}

export type YieldCoordinatorFetchContext = Extract<
  Awaited<ReturnType<typeof runYieldCoordinatorFetchStage>>,
  { ok: true }
>["context"];

export interface YieldCoordinatorHealthTelemetryStageParams {
  db: D1Database;
  fetched: YieldCoordinatorFetchContext;
  normalized: YieldCoordinatorNormalizeContext;
}

export async function runYieldCoordinatorHealthTelemetryStage(
  params: YieldCoordinatorHealthTelemetryStageParams,
) {
  const { fetched, normalized } = params;
  const onChainHealth = await computeDeterministicOnChainHealth({
    db: params.db,
    startSec: fetched.startSec,
    evaluatedSources: normalized.evaluatedSources,
    onChainHealthState: fetched.onChainHealthState,
    onChainSkippedDueToCooldown: fetched.onChainSkippedDueToCooldown,
    onChainAttemptedCount: fetched.onChainAttemptedCount,
    onChainRatesResolved: fetched.onChainRates.size,
    allDeterministicFailed: fetched.allDeterministicFailed,
  });

  logYieldApyDivergences(normalized.evaluatedSources);

  // Every coverage guard result replaces the whole run metadata, so the loaded
  // input counters travel with it: without them a collapsed count only says
  // "the counts dropped", not which input was empty (this is what made the
  // 2026-09-23 held-safety regression opaque from cron history).
  const inputDiagnostics: CronMetadataRecord = {
    resolvedYieldBearingCount: normalized.resolvedYieldBearingIds.size,
    expectedYieldBearingCount: fetched.yieldCoins.length,
    evaluatedSourceCount: normalized.evaluatedSources.length,
    rejectedSourceCount: normalized.evaluatedSources.filter((source) => source.rejected).length,
    selectedSourceCoinCount: normalized.bestSourceKeyByCoin.size,
    dlPoolCount: fetched.dlPools.length,
    dlPoolFallbackMode: fetched.dlPoolsMeta.fallbackMode ?? null,
    supplementalSourceCount: fetched.supplementalCandidates.length,
    supplementalSourceMode: fetched.supplementalMeta.mode,
    onChainRatesResolved: fetched.onChainRates.size,
    safetySnapshotAvailable: fetched.safetySnapshotAvailable,
    safetySnapshotHeld: fetched.safetySnapshotHeld,
    acceptedSafetyPublicationAgeSeconds: fetched.acceptedSafetyPublicationAgeSeconds,
    safetyScoresComputed: fetched.safetySnapshot.coveredCount,
    safetyScoresExpected: fetched.safetySnapshot.trackedCount,
    safetySnapshotReason: fetched.safetySnapshot.reason ?? null,
  };


  const previousYieldPublicationSnapshot = await loadPreviousYieldPublicationSnapshot(params.db);
  const safetySnapshotMeta = buildYieldSafetySnapshotMeta({
    kind: fetched.safetySnapshot.kind,
    coverageRatio: fetched.safetyCoverageRatio,
    coveredCount: fetched.safetySnapshot.coveredCount,
    trackedCount: fetched.safetySnapshot.trackedCount,
    reason: fetched.safetySnapshot.reason ?? null,
    source: fetched.safetySnapshot.source,
    safetyScoreIdentity: fetched.safetySnapshot.safetyScoreIdentity,
    publicationGenerationId: fetched.safetySnapshot.publicationGenerationId,
    methodologyVersion: fetched.safetySnapshot.methodologyVersion,
    publishedAt: fetched.safetySnapshot.publishedAt,
  });
  const { previewRankingsPayload, publicationViews, acceptedSources, quarantineReasons } = buildPreviewYieldRankingsArtifacts({
    evaluatedSources: normalized.evaluatedSources,
    bestSourceKeyByCoin: normalized.bestSourceKeyByCoin,
    riskFreeRate: fetched.riskFreeRate,
    riskFreeRateMeta: fetched.riskFreeRateMeta,
    riskFreeRates: fetched.riskFreeRates,
    dlPoolsMeta: fetched.dlPoolsMeta,
    safetySnapshot: safetySnapshotMeta,
    medianApy: normalized.medianApy,
    startSec: fetched.startSec,
    // B7/B31: the cached payload is the only source of publish-time attribution,
    // so the loaded snapshot must reach the payload builder here.
    previousPublication: {
      rankings: previousYieldPublicationSnapshot.rankings,
      methodologyVersion: previousYieldPublicationSnapshot.methodologyVersion ?? null,
    },
  });
  const publishedCoverageGuard = await guardPublishedYieldCoverage({
    previousYieldPublicationSnapshot,
    previewRankingsPayload,
    yieldCoinIdSet: fetched.yieldCoinIdSet,
    opportunityCoinIdSet: fetched.opportunityCoinIdSet,
    inputDiagnostics,
  });
  if (publishedCoverageGuard.result) {
    await fetched.reportYieldProgress(
      "coverage-guard",
      "Yield published coverage guard deferred publication",
      "yield-publication",
      {
        itemsDone: previewRankingsPayload.rankings.length,
        metadata: {
          guard: "published-coverage",
          countTotals: { previewRankings: previewRankingsPayload.rankings.length },
        },
      },
    );
    return { ok: false as const, result: publishedCoverageGuard.result };
  }

  const degradationReasons = buildYieldDegradationReasons({
    safetyCoverageRatio: fetched.safetyCoverageRatio,
    riskFreeRateRegistryCacheState: fetched.riskFreeRateRegistryCacheState,
    defaultBenchmarkMeta: fetched.riskFreeRateMeta,
    selectedSources: normalized.evaluatedSources.filter(
      (source) => normalized.bestSourceKeyByCoin.get(source.id) === source.sourceKey,
    ),
    dlPoolsMeta: fetched.dlPoolsMeta,
    supplementalMeta: fetched.supplementalMeta,
    stablecoinSupplyMapState: fetched.stablecoinSupplyMapState,
    allDeterministicFailed: fetched.allDeterministicFailed,
    maskedAllDeterministicFailure: onChainHealth.maskedAllDeterministicFailure,
    onChainSkippedDueToCooldown: fetched.onChainSkippedDueToCooldown,
    onChainAlternativeCoverageMissingIds: onChainHealth.onChainAlternativeCoverageMissingIds,
    previousTvlRowsTruncated: normalized.historySnapshots.previousTvlRowsTruncated,
  });
  degradationReasons.push(...quarantineReasons, ...publishedCoverageGuard.qualityReasons);
  await fetched.reportYieldProgress("publication", "Publishing yield rankings generation", "yield-publication", {
    itemsDone: 0,
    itemsTotal: previewRankingsPayload.rankings.length,
    metadata: {
      countTotals: {
        previewRankings: previewRankingsPayload.rankings.length,
        evaluatedSources: normalized.evaluatedSources.length,
      },
      degradationReasons,
    },
  });

  return {
    ok: true as const,
    context: {
      ...onChainHealth,
      safetySnapshotMeta,
      previewRankingsPayload,
      publicationViews,
      acceptedSources,
      degradationReasons,
      previousYieldPublicationSnapshot,
      previousPublishedYieldBearingCount: publishedCoverageGuard.previousPublishedYieldBearingCount,
      currentPublishedYieldBearingCount: publishedCoverageGuard.currentPublishedYieldBearingCount,
      previousPublishedOpportunityCount: publishedCoverageGuard.previousPublishedOpportunityCount,
      currentPublishedOpportunityCount: publishedCoverageGuard.currentPublishedOpportunityCount,
      previousPublishedRankingCount: publishedCoverageGuard.previousPublishedRankingCount,
      currentPublishedRankingCount: publishedCoverageGuard.currentPublishedRankingCount,
    },
  };
}

export type YieldCoordinatorHealthTelemetryContext = Extract<
  Awaited<ReturnType<typeof runYieldCoordinatorHealthTelemetryStage>>,
  { ok: true }
>["context"];

const MIN_YIELD_COVERAGE_RATIO = 0.6;
const MIN_YIELD_COINS_FOR_GUARD = 10;
const MIN_DIRECT_CURATED_QUALITY_RATIO = 0.6;
const MIN_FALLBACK_MODELED_INCREASE = 3;
const FALLBACK_MODELED_INCREASE_RATIO = 0.2;
const QUALITY_MIX_REASON_LIMIT = 2;

type YieldQualityMixRanking = Pick<PreviousYieldPublicationRanking, "dataSource" | "provenance">;

export interface YieldPublicationQualityMix {
  directCuratedCount: number;
  fallbackModeledCount: number;
  unclassifiedCount: number;
  totalCount: number;
}

interface YieldQualityMixRegression {
  reasons: string[];
  minimumDirectCuratedCount: number;
  minimumFallbackModeledIncrease: number;
}

function classifyQualityMixRanking(ranking: YieldQualityMixRanking): "direct-curated" | "fallback-modeled" | null {
  const dataSource = typeof ranking.dataSource === "string" ? ranking.dataSource : null;
  const provenance =
    ranking.provenance != null && typeof ranking.provenance === "object" && !Array.isArray(ranking.provenance)
      ? (ranking.provenance as Record<string, unknown>)
      : null;
  const confidenceTier = provenance && typeof provenance.confidenceTier === "string" ? provenance.confidenceTier : null;

  if (dataSource === "price-derived" || dataSource === "rate-derived" || confidenceTier === "fallback") {
    return "fallback-modeled";
  }
  if (
    confidenceTier === "deterministic" ||
    confidenceTier === "curated" ||
    dataSource === "onchain" ||
    dataSource === "defillama" ||
    dataSource === "protocol-api"
  ) {
    return "direct-curated";
  }
  return null;
}

export function summarizeYieldPublicationQualityMix(
  rankings: readonly YieldQualityMixRanking[],
): YieldPublicationQualityMix {
  let directCuratedCount = 0;
  let fallbackModeledCount = 0;
  for (const ranking of rankings) {
    const cohort = classifyQualityMixRanking(ranking);
    if (cohort === "direct-curated") directCuratedCount += 1;
    if (cohort === "fallback-modeled") fallbackModeledCount += 1;
  }
  return {
    directCuratedCount,
    fallbackModeledCount,
    unclassifiedCount: rankings.length - directCuratedCount - fallbackModeledCount,
    totalCount: rankings.length,
  };
}

function detectYieldQualityMixRegression(
  previous: YieldPublicationQualityMix,
  current: YieldPublicationQualityMix,
): YieldQualityMixRegression | null {
  if (previous.directCuratedCount < MIN_YIELD_COINS_FOR_GUARD) return null;

  const minimumDirectCuratedCount = Math.ceil(previous.directCuratedCount * MIN_DIRECT_CURATED_QUALITY_RATIO);
  const minimumFallbackModeledIncrease = Math.max(
    MIN_FALLBACK_MODELED_INCREASE,
    Math.ceil(previous.directCuratedCount * FALLBACK_MODELED_INCREASE_RATIO),
  );
  const fallbackModeledIncrease = current.fallbackModeledCount - previous.fallbackModeledCount;
  if (
    current.directCuratedCount >= minimumDirectCuratedCount ||
    fallbackModeledIncrease < minimumFallbackModeledIncrease
  ) {
    return null;
  }

  return {
    reasons: ["direct-curated-collapse", "fallback-modeled-substitution"].slice(0, QUALITY_MIX_REASON_LIMIT),
    minimumDirectCuratedCount,
    minimumFallbackModeledIncrease,
  };
}

function countPreviewRankings(
  payload: { rankings: Array<{ id: string }> },
  allowedIds?: Set<string>,
): number {
  return allowedIds
    ? payload.rankings.filter((ranking) => allowedIds.has(ranking.id)).length
    : payload.rankings.length;
}

function buildPublishedCoverageRegressionResult(params: {
  reason: string;
  itemCount: number;
  previousPublishedYieldBearingCount: number;
  currentPublishedYieldBearingCount: number;
  previousPublishedOpportunityCount: number;
  currentPublishedOpportunityCount: number;
  previousPublishedRankingCount: number;
  currentPublishedRankingCount: number;
  inputDiagnostics?: CronMetadataRecord;
}): CronResult {
  return createCronResult({
    status: "degraded",
    itemCount: params.itemCount,
    metadata: {
      reason: params.reason,
      previousPublishedYieldBearingCount: params.previousPublishedYieldBearingCount,
      currentPublishedYieldBearingCount: params.currentPublishedYieldBearingCount,
      previousPublishedOpportunityCount: params.previousPublishedOpportunityCount,
      currentPublishedOpportunityCount: params.currentPublishedOpportunityCount,
      previousPublishedRankingCount: params.previousPublishedRankingCount,
      currentPublishedRankingCount: params.currentPublishedRankingCount,
      publishedRankingCountDelta: params.currentPublishedRankingCount - params.previousPublishedRankingCount,
      // A regression guard result replaces the run metadata, so without the
      // input diagnostics a collapsed count cannot be attributed to an empty
      // input from cron history alone.
      ...(params.inputDiagnostics ? { inputDiagnostics: params.inputDiagnostics } : {}),
    },
  });
}


export async function guardPublishedYieldCoverage(params: {
  previousYieldPublicationSnapshot: PreviousYieldPublicationSnapshot;
  previewRankingsPayload: {
    rankings: Array<{
      id: string;
      dataSource?: unknown;
      provenance?: unknown;
    }>;
  };
  yieldCoinIdSet: Set<string>;
  opportunityCoinIdSet: Set<string>;
  /**
   * Input/cohort counters from the run that produced the preview payload. The
   * guard's result replaces the run metadata, so a blocked publication keeps
   * these to stay attributable from cron history.
   */
  inputDiagnostics?: CronMetadataRecord;
}): Promise<{
  result: CronResult | null;
  qualityReasons: string[];
  previousPublishedYieldBearingCount: number;
  currentPublishedYieldBearingCount: number;
  previousPublishedOpportunityCount: number;
  currentPublishedOpportunityCount: number;
  previousPublishedRankingCount: number;
  currentPublishedRankingCount: number;
}> {
  const previousRankingsState = derivePreviousYieldRankingsCount(params.previousYieldPublicationSnapshot, {
    allowedIds: params.yieldCoinIdSet,
  });
  const previousOpportunityState = derivePreviousYieldRankingsCount(params.previousYieldPublicationSnapshot, {
    allowedIds: params.opportunityCoinIdSet,
  });
  const previousTotalState = derivePreviousYieldRankingsCount(params.previousYieldPublicationSnapshot, {
    allowMalformedRecovery: true,
  });
  const currentPublishedYieldBearingCount = countPreviewRankings(params.previewRankingsPayload, params.yieldCoinIdSet);
  const currentPublishedOpportunityCount = countPreviewRankings(
    params.previewRankingsPayload,
    params.opportunityCoinIdSet,
  );
  const currentPublishedRankingCount = countPreviewRankings(params.previewRankingsPayload);

  if (previousRankingsState.malformed) {
    return {
      qualityReasons: [],
      result: createCronResult({
        status: "degraded",
        itemCount: currentPublishedYieldBearingCount,
        metadata: {
          reason: "previous-yield-rankings-cache-invalid",
          ...(params.inputDiagnostics ? { inputDiagnostics: params.inputDiagnostics } : {}),
        },
      }),
      previousPublishedYieldBearingCount: 0,
      currentPublishedYieldBearingCount,
      previousPublishedOpportunityCount: 0,
      currentPublishedOpportunityCount,
      previousPublishedRankingCount: 0,
      currentPublishedRankingCount,
    };
  }

  const previousPublishedYieldBearingCount = previousRankingsState.count;
  const previousPublishedOpportunityCount = previousOpportunityState.count;
  const previousPublishedRankingCount = previousTotalState.count;

  const qualityReasons: string[] = [];
  for (const [cohort, previous, current] of [
    ["tracked", previousPublishedYieldBearingCount, currentPublishedYieldBearingCount],
    ["opportunity", previousPublishedOpportunityCount, currentPublishedOpportunityCount],
    ["total", previousPublishedRankingCount, currentPublishedRankingCount],
  ] as const) {
    if (previous >= MIN_YIELD_COINS_FOR_GUARD && current < Math.ceil(previous * MIN_YIELD_COVERAGE_RATIO)) {
      qualityReasons.push(`yield-publication:coverage-regression:${cohort}`);
    }
  }
  const expectedTracked = params.inputDiagnostics?.expectedYieldBearingCount;
  if (typeof expectedTracked === "number" && expectedTracked >= MIN_YIELD_COINS_FOR_GUARD &&
      currentPublishedYieldBearingCount < Math.ceil(expectedTracked * MIN_YIELD_COVERAGE_RATIO) &&
      !qualityReasons.includes("yield-publication:coverage-regression:tracked")) {
    qualityReasons.push("yield-publication:coverage-regression:tracked");
  }
  const previousMix = summarizeYieldPublicationQualityMix(params.previousYieldPublicationSnapshot.rankings);
  if (detectYieldQualityMixRegression(previousMix, summarizeYieldPublicationQualityMix(params.previewRankingsPayload.rankings)) &&
      !qualityReasons.includes("yield-publication:coverage-regression:total")) {
    qualityReasons.push("yield-publication:coverage-regression:total");
  }
  // Retain the existing absolute safety net in one place. Cohort loss alone
  // cannot hold unrelated validated assets.
  const hardFloorFailed = currentPublishedRankingCount === 0 ||
    (previousPublishedRankingCount >= 5 && currentPublishedRankingCount < Math.ceil(previousPublishedRankingCount * 0.4));
  const reason = params.inputDiagnostics?.safetySnapshotAvailable === false
    ? "safety-snapshot-unavailable"
    : hardFloorFailed ? "rankings-payload-shrunk" : null;
  if (qualityReasons.length > 0) {
    logWorkerEventArgs("handler", "error", "[sync-yield-data] Publication coverage regression", qualityReasons);
  }
  return {
    qualityReasons,
    result: reason == null ? null : buildPublishedCoverageRegressionResult({
      reason,
      itemCount: currentPublishedRankingCount,
      previousPublishedYieldBearingCount,
      currentPublishedYieldBearingCount,
      previousPublishedOpportunityCount,
      currentPublishedOpportunityCount,
      previousPublishedRankingCount,
      currentPublishedRankingCount,
      inputDiagnostics: params.inputDiagnostics,
    }),
    previousPublishedYieldBearingCount,
    currentPublishedYieldBearingCount,
    previousPublishedOpportunityCount,
    currentPublishedOpportunityCount,
    previousPublishedRankingCount,
    currentPublishedRankingCount,
  };
}

type DeterministicOnChainHealthState = Parameters<
  typeof buildNextDeterministicOnChainHealthState
>[0]["previous"];

function logYieldApyDivergences(evaluatedSources: EvaluatedYieldSource[]): void {
  const nativeApyByCoin = new Map<string, number>();
  const lendingApyByCoin = new Map<string, number>();

  for (const source of evaluatedSources) {
    if (source.yieldType === "lending-opportunity" || source.yieldType === "fixed-yield") {
      lendingApyByCoin.set(source.id, source.currentApy);
    } else {
      nativeApyByCoin.set(source.id, source.currentApy);
    }
  }

  for (const [coinId, nativeApy] of nativeApyByCoin) {
    const lendingApy = lendingApyByCoin.get(coinId);
    if (lendingApy == null || nativeApy <= 0 || lendingApy <= 0) continue;

    const divergence = Math.abs(nativeApy - lendingApy) / Math.max(Math.abs(nativeApy), Math.abs(lendingApy), 1e-9);
    if (divergence <= 0.35) continue;

    logWorkerEventArgs("handler", "warn",
      `[yield-sync] APY divergence for ${coinId}: native=${nativeApy.toFixed(1)}% vs lending=${lendingApy.toFixed(1)}%`,
    );
  }
}

export function getPublishableNonOnchainCoverageIds(
  evaluatedSources: readonly EvaluatedYieldSource[],
): Set<string> {
  return new Set(
    evaluatedSources
      .filter((source) => source.dataSource !== "onchain" && !source.rejected)
      .map((source) => source.id),
  );
}

async function computeDeterministicOnChainHealth(params: {
  db: D1Database;
  startSec: number;
  evaluatedSources: EvaluatedYieldSource[];
  onChainHealthState: DeterministicOnChainHealthState;
  onChainSkippedDueToCooldown: boolean;
  onChainAttemptedCount: number;
  onChainRatesResolved: number;
  allDeterministicFailed: boolean;
}): Promise<{
  maskedAllDeterministicFailure: boolean;
  onChainAlternativeCoverageMissingIds: string[];
  nextOnChainHealthState: DeterministicOnChainHealthState;
  onChainCooldownTriggered: boolean;
}> {
  const deterministicSourceIds = Array.from(
    new Set(ON_CHAIN_RATE_CONFIGS.map((config) => config.stablecoinId)),
  );
  const nonOnchainEvaluatedIds = getPublishableNonOnchainCoverageIds(params.evaluatedSources);
  const onChainAlternativeCoverageMissingIds = deterministicSourceIds.filter(
    (id) => !nonOnchainEvaluatedIds.has(id),
  );
  const maskedAllDeterministicFailure =
    params.allDeterministicFailed &&
    deterministicSourceIds.length > 0 &&
    onChainAlternativeCoverageMissingIds.length === 0;
  const nextOnChainHealthState = buildNextDeterministicOnChainHealthState({
    deterministicConfigCount: deterministicSourceIds.length,
    previous: params.onChainHealthState,
    startSec: params.startSec,
    onChainAttemptedCount: params.onChainAttemptedCount,
    onChainRatesResolved: params.onChainRatesResolved,
    allDeterministicFailed: params.allDeterministicFailed,
    maskedAllDeterministicFailure,
    onChainAlternativeCoverageMissingIds,
    onChainSkippedDueToCooldown: params.onChainSkippedDueToCooldown,
  });
  const onChainCooldownTriggered =
    !params.onChainSkippedDueToCooldown &&
    nextOnChainHealthState.cooldownUntil != null &&
    nextOnChainHealthState.cooldownUntil > params.startSec;

  await persistDeterministicOnChainHealthState(params.db, params.startSec, nextOnChainHealthState);

  if (params.allDeterministicFailed && maskedAllDeterministicFailure) {
    logWorkerEventArgs("handler", "warn",
      "[sync-yield-data] Deterministic on-chain lane failed, but all configured coins retained non-onchain yield coverage",
    );
  }

  return {
    maskedAllDeterministicFailure,
    onChainAlternativeCoverageMissingIds,
    nextOnChainHealthState,
    onChainCooldownTriggered,
  };
}

export interface YieldCoordinatorPersistStageParams {
  db: D1Database;
  signal?: AbortSignal;
  fetched: YieldCoordinatorFetchContext;
  normalized: YieldCoordinatorNormalizeContext;
  health: YieldCoordinatorHealthTelemetryContext;
}

export async function runYieldCoordinatorPersistStage(
  params: YieldCoordinatorPersistStageParams,
): Promise<CronResult> {
  const { fetched, normalized, health } = params;
  const loadedSafetyIdentity = health.safetySnapshotMeta.safetyScoreIdentity ?? null;
  let safetyIdentityChangedBeforePublish: YieldSafetyIdentityChangeMeta | null = null;
  if (loadedSafetyIdentity) {
    const currentSafetySource = await loadActiveSafetyScoreIdentity(params.db);
    const currentSafetyIdentity = currentSafetySource.safetyScoreIdentity;
    if (
      currentSafetySource.kind === "v9" &&
      currentSafetyIdentity &&
      !safetyScorePublicationIdentitiesAreComparable(loadedSafetyIdentity, currentSafetyIdentity)
    ) {
      // The run still publishes: its results are coherent under the identity it
      // loaded, and the read path serves them as a publish-time snapshot until
      // the next run re-aligns. Withholding the publish would only pin an
      // older, equally mismatched cache (2026-08-19 incident).
      safetyIdentityChangedBeforePublish = {
        reason: "yield-safety-identity-changed-before-publish",
        loadedPublicationGenerationId: loadedSafetyIdentity.publicationGenerationId,
        currentPublicationGenerationId: currentSafetyIdentity.publicationGenerationId,
        loadedEvaluationBuildDigest: loadedSafetyIdentity.evaluationBuildDigest,
        currentEvaluationBuildDigest: currentSafetyIdentity.evaluationBuildDigest,
      };
      logWorkerEvent({
        scope: "lib",
        level: "warn",
        event: safetyIdentityChangedBeforePublish.reason,
        job: "sync-yield-data",
        message:
          "Safety Score V9 identity changed after yield inputs were loaded; publishing the coherent loaded-identity results",
        metadata: {
          loadedPublicationGenerationId: loadedSafetyIdentity.publicationGenerationId,
          currentPublicationGenerationId: currentSafetyIdentity.publicationGenerationId,
          loadedEvaluationBuildDigest: loadedSafetyIdentity.evaluationBuildDigest,
          currentEvaluationBuildDigest: currentSafetyIdentity.evaluationBuildDigest,
        },
      });
    }
  }
  const publicationResult = await publishYieldCoordinatorResults({
    db: params.db,
    signal: params.signal,
    previewRankingsPayload: health.previewRankingsPayload,
    evaluatedSources: health.acceptedSources,
    publicationViews: health.publicationViews,
    startSec: fetched.startSec,
    degradationReasons: health.degradationReasons,
    safetySnapshotHeld: fetched.safetySnapshotHeld,
    resolvedCount: normalized.resolvedIds.length,
    rowsRejected: normalized.rowsRejected,
    divergenceFlags: normalized.divergenceFlags,
    sourceSwitches: normalized.sourceSwitches,
    previousYieldPublicationSnapshot: health.previousYieldPublicationSnapshot,
  });
  if (!publicationResult.ok) {
    await fetched.reportYieldProgress(
      "publication-blocked",
      "Yield publication was blocked",
      "yield-publication",
      {
        itemsDone: 0,
        itemsTotal: health.previewRankingsPayload.rankings.length,
        metadata: {
          countTotals: { previewRankings: health.previewRankingsPayload.rankings.length },
        },
      },
    );
    return publicationResult.result;
  }

  const publicationApplied = !publicationResult.cacheWriteSkipped;
  if (publicationApplied) {
    logWorkerEvent({
      scope: "lib",
      level: "info",
      event: "yield-publication-complete",
      job: "sync-yield-data",
      message: "Yield source rows and rankings publication completed",
      metadata: {
        updatedCount: publicationResult.updatedCount,
        yieldBearingCoins: fetched.yieldCoins.length,
      },
    });
  } else {
    // The atomic write did not apply, so nothing was published: this run keeps
    // serving the previous generation and must not read as a completed one.
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      event: "publication-skipped",
      job: "sync-yield-data",
      message: "Yield publication skipped; the previous published generation is retained",
      metadata: {
        reason: publicationResult.skipReason,
        cacheWriteSkipped: true,
        casSkipped: publicationResult.casSkipped,
        yieldBearingCoins: fetched.yieldCoins.length,
      },
    });
  }
  await fetched.reportYieldProgress(
    publicationApplied ? "publication-complete" : "publication-skipped",
    publicationApplied
      ? "Published yield rankings generation"
      : "Yield publication skipped; previous generation retained",
    "yield-publication",
    {
      itemsDone: publicationResult.updatedCount,
      itemsTotal: health.previewRankingsPayload.rankings.length,
      metadata: {
        countTotals: {
          rowsWritten: publicationResult.updatedCount,
          publishedRankingCount: health.currentPublishedRankingCount,
          previousPublishedRankingCount: health.previousPublishedRankingCount,
        },
        degradationReasons: publicationResult.degradationReasons,
        cacheWriteSkipped: publicationResult.cacheWriteSkipped,
        cacheWriteSkipReason: publicationResult.skipReason,
      },
    },
  );
  const status = publicationApplied ? "ok" : "degraded";
  return {
    itemCount: publicationResult.updatedCount,
    status,
    productivity: {
      productive: publicationApplied,
      reason: publicationApplied ? "yield-rankings-published" : publicationResult.skipReason ?? "yield-publication-not-applied",
      publications: publicationApplied ? [{
        surface: "yield-rankings",
        generationId: publicationResult.generationId,
        publishedAt: fetched.startSec,
        candidateRows: health.previewRankingsPayload.rankings.length,
        publishedRows: health.currentPublishedRankingCount,
        artifactCacheKey: "yield-rankings",
      }] : [],
    },
    metadata: buildYieldSyncMetadata({
      rowsRead: fetched.yieldCoins.length,
      rowsWritten: publicationResult.updatedCount,
      rowsRejected: normalized.rowsRejected,
      divergenceFlags: normalized.divergenceFlags,
      sourceSwitches: normalized.sourceSwitches,
      defaultSafetyCoinCount: normalized.defaultSafetyIds.size,
      safetySnapshot: health.safetySnapshotMeta,
      safetySnapshotHeld: fetched.safetySnapshotHeld,
      resolvedYieldBearingCount: normalized.resolvedYieldBearingIds.size,
      expectedYieldBearingCount: fetched.yieldCoins.length,
      publishedYieldBearingCount: health.currentPublishedYieldBearingCount,
      previousPublishedYieldBearingCount: health.previousPublishedYieldBearingCount,
      publishedOpportunityCount: health.currentPublishedOpportunityCount,
      previousPublishedOpportunityCount: health.previousPublishedOpportunityCount,
      publishedRankingCount: health.currentPublishedRankingCount,
      previousPublishedRankingCount: health.previousPublishedRankingCount,
      dlPoolsMeta: fetched.dlPoolsMeta,
      dlApyEnvelopeRejectedCount: fetched.dlApyEnvelopeRejectedCount,
      supplementalMeta: fetched.supplementalMeta,
      stablecoinSupplyMapState: fetched.stablecoinSupplyMapState,
      optionalSourceFailures: normalized.optionalSourceFailures,
      onChain: {
        ratesResolved: fetched.onChainRates.size,
        ratesConfigured: ON_CHAIN_RATE_CONFIGS.length,
        envelopeRejections: normalized.envelopeRejections,
        attempted: fetched.onChainAttemptedCount,
        allDeterministicFailed: fetched.allDeterministicFailed,
        explorerAttempted: fetched.onChainExplorerAttemptedCount,
        explorerResolved: fetched.onChainExplorerResolvedCount,
        failureMaskedByAlternativeCoverage: health.maskedAllDeterministicFailure,
        alternativeCoverageMissingIds: health.onChainAlternativeCoverageMissingIds,
        failures: fetched.onChainFailures,
        skippedDueToCooldown: fetched.onChainSkippedDueToCooldown,
        cooldownTriggered: health.onChainCooldownTriggered,
        cooldownUntil: health.nextOnChainHealthState.cooldownUntil,
        cooldownRemainingSec: fetched.onChainCooldownRemainingSec,
        consecutiveAllFailRuns: health.nextOnChainHealthState.consecutiveAllFailRuns,
        consecutiveMaskedAllFailRuns: health.nextOnChainHealthState.consecutiveMaskedAllFailRuns,
      },
      qualityReasons: publicationResult.degradationReasons,
      ...(!publicationApplied ? { reason: publicationResult.skipReason ?? "yield-publication-not-applied" } : {}),
      validationFailures: publicationResult.validationFailures,
      riskFreeRate: fetched.riskFreeRate,
      cacheWriteSkipped: publicationResult.cacheWriteSkipped,
      comparisonAnchorFreshness: buildComparisonAnchorFreshnessMeta({
        evaluatedSources: normalized.evaluatedSources,
        startSec: fetched.startSec,
      }),
      previousTvlRowsTruncated: normalized.historySnapshots.previousTvlRowsTruncated,
      publicationStats: publicationResult.publicationStats,
      safetyIdentityChangedBeforePublish,
    }),
  };
}
