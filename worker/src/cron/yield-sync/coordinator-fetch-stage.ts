import { ACTIVE_YIELD_BEARING_STABLECOINS } from "@shared/lib/tracked-stablecoin-utils";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import type { CronProgressReporter } from "../../lib/cron-logger";
import { createCronResult } from "../../lib/cron-result";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { getCache } from "../../lib/db-cache";
import { logWorkerEvent } from "../../lib/structured-log";
import {
  YIELD_HISTORY_CLEANUP_WRITER_PAUSE_KEY,
  parseYieldHistoryWriterPause,
} from "../../lib/yield-history-cleanup";
import { ON_CHAIN_RATE_CONFIGS } from "../../lib/yield-config/yield-config";
import { createYieldProgressReporter } from "../yield-progress";
import { repairPublishedYieldGenerationFromCache } from "./publication";
import { loadYieldSyncState } from "./state-loading";

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
    // hold as a degradation reason instead of deferring.
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
  } else if (loadedState.safetySnapshotDegraded) {
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
      loadedState.safetySnapshot.reason ?? "safety-score-v9-publication:identity-missing";
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
