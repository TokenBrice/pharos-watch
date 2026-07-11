import { recalcAffectedHours } from "../../lib/mint-burn-pipeline/persistence";
import { getNullPriceBacklog, healNullPrices } from "../../lib/mint-burn-pipeline/price-heal";
import { sweepRecentRoundtrips } from "../../lib/mint-burn-pipeline/roundtrip-sweep";
import { mintBurnConfigKey } from "../../lib/mint-burn-pipeline/sync-state";
import type { MintBurnAffectedHour, SyncMintBurnStatus, MintBurnLane } from "../../lib/mint-burn-pipeline/types";
import type { MintBurnContractConfig } from "../../lib/mint-burn-contracts";
import { withBudgetMetadata } from "../../lib/cron-progress";
import {
  setMintBurnRunState,
  type MintBurnAttemptCoverageSummary,
  type MintBurnRunStateRow,
} from "./run-state";
import type { MintBurnConfigSummary } from "./sync-config";
import { logWorkerEvent } from "../../lib/structured-log";
import { throwIfAborted } from "../../lib/abort";

// healNullPrices only heals events inside its 48h LOOKBACK_SEC window; events older
// than that are intentionally left unhealed (their cached prices are no longer
// replay-safe). A non-zero historical backlog still permanently skews burn_volume_usd
// and DEWS flow signals, so we surface it as a structured warning once it crosses this
// threshold rather than letting it silently accumulate in run metadata.
const NULL_PRICE_HISTORICAL_BACKLOG_WARN_THRESHOLD = 50;

export async function completeMintBurnRun(input: {
  db: D1Database;
  budget: { limit: number; count: number };
  lane: MintBurnLane;
  jobName: string;
  chainHeads: Map<string, number>;
  resumeConfigKey: string | null;
  enabledConfigs: MintBurnContractConfig[];
  configs: MintBurnContractConfig[];
  configsDisabled: number;
  contractsTotal: number;
  lastBlocksAfterRun: Map<string, number>;
  runState: MintBurnRunStateRow;
  runStatePersistenceFailed: boolean;
  degradeConsecutiveThreshold: number;
  errorConsecutiveThreshold: number;
  rowsRead: number;
  rowsParsed: number;
  rowsInserted: number;
  rowsIgnored: number;
  rowsDropped: number;
  contractsProcessed: number;
  contractsSkipped: number;
  contractsDeferredExtended: number;
  apiErrors: number;
  effectiveBurns: number;
  bridgeBurns: number;
  reviewBurns: number;
  atomicRoundtripsTotal: number;
  txContextShortfalls: number;
  bridgeClassificationDeferredRows: number;
  criticalContractsEnabled: number;
  criticalContractsSatisfied: number;
  criticalContractsUnsatisfied: number;
  configBreakdown: MintBurnConfigSummary[];
  runtimeBudgetHit: boolean;
  attemptCoverage: MintBurnAttemptCoverageSummary;
  runDrilldown: { cacheKey: string; persistenceFailed: boolean };
  signal?: AbortSignal;
}): Promise<{ status: SyncMintBurnStatus; metadata: Record<string, unknown>; error: string | null }> {
  const laggingConfigs = input.configs
    .map((config) => {
      const key = mintBurnConfigKey(config);
      const last = input.lastBlocksAfterRun.get(key) ?? (config.startBlock - 1);
      const head = input.chainHeads.get(config.chain.chainId) ?? null;
      return {
        key,
        symbol: config.symbol,
        chainId: config.chain.chainId,
        lagBlocks: head != null ? Math.max(0, head - last) : null,
        head,
        lastBlock: last,
      };
    })
    .sort((a, b) => (b.lagBlocks ?? -1) - (a.lagBlocks ?? -1))
    .slice(0, 6);

  const coverageRatio = input.enabledConfigs.length > 0 ? input.contractsProcessed / input.enabledConfigs.length : 1;
  const criticalCoverageRatio =
    input.criticalContractsEnabled > 0 ? input.criticalContractsSatisfied / input.criticalContractsEnabled : 1;
  const degradedSignal =
    input.lane === "extended"
      ? input.apiErrors > 1 || input.attemptCoverage.staleAttemptCount > 0
      : criticalCoverageRatio < 1 || input.apiErrors > 1;
  const degradedStreak = degradedSignal ? input.runState.degradedStreak + 1 : 0;

  let status: SyncMintBurnStatus = "ok";
  let error: string | null = null;
  if (input.lane !== "extended" && degradedStreak >= input.errorConsecutiveThreshold) {
    status = "error";
    error =
      `Degraded for ${degradedStreak} consecutive runs: ` +
      `critical coverage ${input.criticalContractsSatisfied}/${input.criticalContractsEnabled}, ` +
      `apiErrors=${input.apiErrors}`;
  } else if (degradedStreak >= input.degradeConsecutiveThreshold) {
    status = "degraded";
  }
  if (
    status === "ok"
    && (
      input.attemptCoverage.staleAttemptCount > 0
      || input.attemptCoverage.persistenceFailed
      || input.runDrilldown.persistenceFailed
    )
  ) {
    status = "degraded";
  }

  throwIfAborted(input.signal);

  const runStatePersisted = await setMintBurnRunState(
    input.db, input.jobName, degradedStreak, input.resumeConfigKey,
  );
  const runStatePersistenceFailed = input.runStatePersistenceFailed || !runStatePersisted;
  if (runStatePersistenceFailed && status === "ok") {
    status = "degraded";
  }

  throwIfAborted(input.signal);
  const nowSec = Math.floor(Date.now() / 1000);
  let nullPricesHealed = 0;
  const nullPriceBacklog = await getNullPriceBacklog(input.db, nowSec);
  throwIfAborted(input.signal);
  if (nullPriceBacklog.historical > NULL_PRICE_HISTORICAL_BACKLOG_WARN_THRESHOLD) {
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      event: "sync-mint-burn.historical-null-price-backlog",
      job: "sync-mint-burn",
      message: "Historical NULL amount_usd backlog exceeds threshold",
      metadata: {
        historical: nullPriceBacklog.historical,
        threshold: NULL_PRICE_HISTORICAL_BACKLOG_WARN_THRESHOLD,
      },
    });
  }
  if (status !== "error") {
    try {
      throwIfAborted(input.signal);
      const healResult = await healNullPrices(input.db, nowSec);
      nullPricesHealed = healResult.healed;
      if (healResult.affectedHours.size > 0) {
        await recalcAffectedHours(input.db, healResult.affectedHours as Map<string, MintBurnAffectedHour>, {
          signal: input.signal,
        });
      }
    } catch (error) {
      throwIfAborted(input.signal);
      logWorkerEvent({
        scope: "lib",
        level: "warn",
        event: "sync-mint-burn.price-heal-failed",
        job: "sync-mint-burn",
        message: "Price heal failed",
        error,
      });
    }
  }

  let roundtripSweepCount = 0;
  let roundtripsBacklogSaturated = false;
  if (status !== "error") {
    try {
      throwIfAborted(input.signal);
      const sweepResult = await sweepRecentRoundtrips(input.db, nowSec, undefined, input.signal);
      roundtripSweepCount = sweepResult.reclassified;
      roundtripsBacklogSaturated = sweepResult.saturated;
      if (roundtripSweepCount > 0) {
        logWorkerEvent({
          scope: "lib",
          level: "info",
          event: "sync-mint-burn.roundtrip-sweep-reclassified",
          job: "sync-mint-burn",
          message: "Roundtrip sweep reclassified rows",
          metadata: { reclassified: roundtripSweepCount },
        });
      }
    } catch (error) {
      throwIfAborted(input.signal);
      logWorkerEvent({
        scope: "lib",
        level: "warn",
        event: "sync-mint-burn.roundtrip-sweep-failed",
        job: "sync-mint-burn",
        message: "Roundtrip sweep failed",
        error,
      });
    }
  }

  const compatibilityChainHead = input.chainHeads.get("ethereum")
    ?? Math.max(0, ...input.chainHeads.values());
  const skippedReasonCounts: Record<string, number> = {};
  for (const summary of input.configBreakdown) {
    if (summary.skippedReason) {
      skippedReasonCounts[summary.skippedReason] = (skippedReasonCounts[summary.skippedReason] ?? 0) + 1;
    }
  }
  const sampledConfigKeys = new Set<string>();
  const sampledConfigs = [
    ...input.configBreakdown.slice(0, 6),
    ...input.configBreakdown.filter(
      (summary) => summary.errors > 0 || summary.skippedReason != null || summary.rowsInserted > 0,
    ),
  ].filter((summary) => {
    if (sampledConfigKeys.has(summary.key)) return false;
    sampledConfigKeys.add(summary.key);
    return true;
  });
  const configSamples = sampledConfigs
    .slice(0, 12)
    .map((summary) => ({
      key: summary.key,
      symbol: summary.symbol,
      chainId: summary.chainId,
      tier: summary.tier,
      attempted: summary.attempted,
      skippedReason: summary.skippedReason,
      rowsRead: summary.rowsRead,
      rowsInserted: summary.rowsInserted,
      rowsDropped: summary.rowsDropped,
      errors: summary.errors,
      scanFrom: summary.scanFrom,
      scanTo: summary.scanTo,
      advancedTo: summary.advancedTo,
      coverageFrontier: summary.coverageFrontier,
      advanceReason: summary.advanceReason,
      failedEventDefs: summary.failedEventDefs.slice(0, 8),
      missingTimestampCount: summary.missingTimestampCount,
      earliestMissingTimestampBlock: summary.earliestMissingTimestampBlock,
      txContextShortfalls: summary.txContextShortfalls,
      bridgeClassificationDeferredRows: summary.bridgeClassificationDeferredRows,
      requestBudgetUsed: summary.requestBudgetUsed,
      requestBudgetLimit: summary.requestBudgetLimit,
    }));

  const metadata = withBudgetMetadata(input.budget, {
    lane: input.lane,
    jobName: input.jobName,
    chainHead: compatibilityChainHead || null,
    chainHeads: Object.fromEntries(input.chainHeads),
    rowsRead: input.rowsRead,
    rowsParsed: input.rowsParsed,
    rowsInserted: input.rowsInserted,
    rowsIgnored: input.rowsIgnored,
    rowsDropped: input.rowsDropped,
    sourceCoverage: {
      contractsProcessed: input.contractsProcessed,
      contractsSkipped: input.contractsSkipped,
      contractsEnabled: input.enabledConfigs.length,
      contractsDisabled: input.configsDisabled,
      contractsTotal: input.contractsTotal,
    },
    configsDisabled: input.configsDisabled,
    contractsProcessed: input.contractsProcessed,
    contractsSkipped: input.contractsSkipped,
    contractsDeferredExtended: input.contractsDeferredExtended,
    apiErrors: input.apiErrors,
    validationFailures: 0,
    fallbackMode: null,
    burnClassification: {
      effectiveBurns: input.effectiveBurns,
      bridgeBurns: input.bridgeBurns,
      reviewBurns: input.reviewBurns,
    },
    atomicRoundtripsDetected: input.atomicRoundtripsTotal,
    bridgeClassification: {
      txContextShortfalls: input.txContextShortfalls,
      deferredRows: input.bridgeClassificationDeferredRows,
    },
    criticalCoverage: {
      contractsEnabled: input.criticalContractsEnabled,
      contractsSatisfied: input.criticalContractsSatisfied,
      contractsUnsatisfied: input.criticalContractsUnsatisfied,
      ratio: criticalCoverageRatio,
    },
    configBreakdownSummary: {
      total: input.configBreakdown.length,
      attempted: input.configBreakdown.filter((summary) => summary.attempted).length,
      skipped: input.configBreakdown.filter((summary) => summary.skippedReason != null).length,
      withErrors: input.configBreakdown.filter((summary) => summary.errors > 0).length,
      skippedReasonCounts,
    },
    configSamples,
    runDrilldownCacheKey: input.runDrilldown.cacheKey,
    runDrilldownPersistenceFailed: input.runDrilldown.persistenceFailed,
    resumeConfigKey: input.resumeConfigKey,
    attemptCoverage: input.attemptCoverage,
    laggingConfigs,
    coverageRatio,
    runtimeBudgetHit: input.runtimeBudgetHit,
    degradedSignal,
    degradedStreak,
    runStatePersistenceFailed,
    nullPricesHealed,
    nullPriceBacklog,
    nullPriceBacklogRecent: nullPriceBacklog.recent,
    nullPriceBacklogHistorical: nullPriceBacklog.historical,
    roundtripSweepCount,
    roundtripsBacklogSaturated,
  });

  return { status, metadata, error };
}
