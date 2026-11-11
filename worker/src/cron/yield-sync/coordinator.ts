import {
  buildComparisonAnchorFreshnessMeta,
  buildYieldSafetySnapshotMeta,
  buildYieldSyncMetadata,
  type YieldSafetyIdentityChangeMeta,
} from "./run-result";
import {
  buildYieldDegradationReasons,
  computeDeterministicOnChainHealth,
  guardPublishedYieldCoverage,
  logYieldApyDivergences,
} from "./health-policy";
import {
  evaluateYieldSourcesCooperative,
} from "./evaluation";
import {
  loadYieldSyncState,
} from "./state";
import type {
  YieldOptionalSourceOutcome,
} from "./sources-rpc";
import { repairPublishedYieldGenerationFromCache } from "./publication-generation";
import { buildPreviewYieldRankingsArtifacts, publishYieldCoordinatorResults } from "./publication";
import { loadPreviousYieldPublicationSnapshot } from "./publication-admission";
import type {
  ChainRpcConfig,
} from "../../lib/chain-registry";
import { buildYieldHistoryEvaluationInputsCooperative } from "./history-evidence";
import { loadYieldHistorySnapshots } from "./history-repository";
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
} from "../../lib/structured-log";
import {
  YIELD_HISTORY_CLEANUP_WRITER_PAUSE_KEY,
  parseYieldHistoryWriterPause,
} from "../../lib/yield/yield-history-cleanup";
import { ON_CHAIN_RATE_CONFIGS } from "../../lib/yield-config/yield-config-rate-sources";
import {
  createYieldProgressReporter,
} from "./yield-progress";
import {
  safetyScorePublicationIdentitiesShareScoringContract,
} from "@shared/lib/safety-score-publication";
import {
  loadActiveSafetyScoreIdentity,
} from "../../lib/safety-score-v9/safety-score-active-source";

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

  const anchorOnlySources = resolved.filter((entry) => entry.yield?.observationKind === "anchor-only");
  const resolvedWithYield = resolved.filter((entry) =>
    entry.yield != null && entry.yield.observationKind !== "anchor-only");
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
        anchorOnlySources: anchorOnlySources.length,
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
    anchorOnlySources,
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
    anchorOnlySourceCount: normalized.anchorOnlySources.length,
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
      !safetyScorePublicationIdentitiesShareScoringContract(loadedSafetyIdentity, currentSafetyIdentity)
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
    anchorOnlySources: normalized.anchorOnlySources,
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
      startSec: fetched.startSec,
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
