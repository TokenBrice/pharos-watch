import { ACTIVE_YIELD_BEARING_STABLECOINS } from "@shared/lib/tracked-stablecoin-utils";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import type { CronProgressReporter, CronResult } from "../../lib/cron-logger";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { getCache } from "../../lib/db-cache";
import { logWorkerEvent } from "../../lib/structured-log";
import {
  YIELD_HISTORY_CLEANUP_WRITER_PAUSE_KEY,
  parseYieldHistoryWriterPause,
} from "../../lib/yield-history-cleanup";
import { ON_CHAIN_RATE_CONFIGS } from "../yield-config";
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
    return { ok: false as const, result: { itemCount: 0, metadata: "no yield-bearing coins" } satisfies CronResult };
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
      result: {
        status: "degraded" as const,
        itemCount: 0,
        metadata: JSON.stringify({
          writerPaused: true,
          pauseReason: writerPause.reason,
          pauseOperator: writerPause.operator,
          pausedAt: writerPause.pausedAt,
        }),
      },
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
      onChainCooldownActive: loadedState.onChainCooldownActive,
      onChainCooldownRemainingSec: loadedState.onChainCooldownRemainingSec,
    },
  });

  if (loadedState.safetySnapshotDegraded) {
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
