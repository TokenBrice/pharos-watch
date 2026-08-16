import { logWorkerEventArgs } from "../lib/structured-log";
import { materializeBlacklistGapMetrics } from "../lib/blacklist-gaps";
import { materializeBlacklistSummarySnapshot } from "../lib/blacklist-summary-service";
import { type RateLimitedFetch, createRateLimiter } from "../lib/evm-logs";
import { type ChainRpcConfig } from "../lib/chain-registry";
import type { CronProgressReporter } from "../lib/cron-logger";
import { reportCronProgress, withBudgetMetadata } from "../lib/cron-progress";
import { backfillAmounts, type BlacklistAmountBackfillResult } from "../lib/blacklist/amount-recovery";
import {
  blacklistRuntimeBudgetReached,
  blacklistSubrequestBudgetReached,
  createBlacklistRunBudget,
  type BlacklistRunBudget,
} from "../lib/blacklist/run-budget";
import { applyTronLedgerMirrorPass, deriveSyncBlacklistStatus } from "./blacklist/sync-support";
import { toErrorMessage } from "../lib/error-utils";
import { getOldestBlacklistSuccessAt } from "./blacklist/state";
import { migrateLegacyBlacklistIdentities, type BlacklistLegacyIdentityMigrationResult } from "./blacklist/legacy-identity-migration";
import { scanBlacklistConfigs } from "./blacklist/config-scan";

const SYNC_BLACKLIST_RUNTIME_BUDGET_MS = 10 * 60_000;
const SYNC_BLACKLIST_MAINTENANCE_BUDGET_MS = 10 * 60_000 + 45_000;
const SYNC_BLACKLIST_MIN_CONFIG_WINDOW_MS = 60_000;
const BLACKLIST_AMOUNT_REPAIR_EXHAUSTED_SCAN_LIMIT = 10;
const BLACKLIST_PRODUCER_SNAPSHOT_MIN_WINDOW_MS = 10_000;
// createRateLimiter is intentionally serial. Keep the declared live
// concurrency aligned with that implementation and the shared six-connection
// trigger budget; throughput is controlled independently by requests/second.
const BLACKLIST_PROVIDER_LIVE_CONCURRENCY = 1;
const BLACKLIST_PROVIDER_REQUESTS_PER_SECOND = 3;

type SyncBlacklistResult = {
  itemCount: number;
  metadata: string;
  status: "ok" | "degraded" | "error";
};

export interface SyncBlacklistOptions {
  db: D1Database;
  etherscanApiKey: string | null;
  trongridApiKey: string | null;
  drpcApiKey: string | null;
  externalEtherscanRL?: RateLimitedFetch;
  signal?: AbortSignal;
  onProgress?: CronProgressReporter;
  chainRpcs?: Map<string, ChainRpcConfig>;
}

export async function syncBlacklist(opts: SyncBlacklistOptions): Promise<SyncBlacklistResult> {
  const { db, etherscanApiKey, trongridApiKey, drpcApiKey, externalEtherscanRL, signal, onProgress, chainRpcs } = opts;
  const etherscanLimiter = externalEtherscanRL ?? createRateLimiter(BLACKLIST_PROVIDER_REQUESTS_PER_SECOND);
  const tronLimiter = createRateLimiter(BLACKLIST_PROVIDER_REQUESTS_PER_SECOND);
  const runStartedAtMs = Date.now();
  const runBudget = createBlacklistRunBudget({
    subrequestLimit: 900,
    runtimeBudgetMs: SYNC_BLACKLIST_RUNTIME_BUDGET_MS,
    minimumConfigWindowMs: SYNC_BLACKLIST_MIN_CONFIG_WINDOW_MS,
  });
  const maintenanceRunBudget: BlacklistRunBudget = {
    ...runBudget,
    deadlineMs: runStartedAtMs + SYNC_BLACKLIST_MAINTENANCE_BUDGET_MS,
    minimumConfigWindowMs: 0,
  };
  const budget = runBudget.subrequestBudget;
  const scan = await scanBlacklistConfigs({
    db,
    etherscanApiKey,
    trongridApiKey,
    drpcApiKey,
    etherscanLimiter,
    tronLimiter,
    runBudget,
    signal,
    onProgress,
    chainRpcs,
  });
  const {
    totalFetchedEvents,
    contractsSkipped,
    apiErrors,
    rpcLogConfigs,
    providerCircuitSkips,
    tronGridCircuitSkips,
    incompleteRuntimeConfigs,
    counters,
    apiErrorClasses,
    apiErrorConfigs,
    configsAttempted,
    configsSucceeded,
    stateConflicts,
    blacklistProviderCalls,
    maxProviderSplitDepth,
    coverageOutcomeCounts,
    configStates,
    zeroCursorConfigs,
    etherscanCircuitAllowed,
  } = scan;
  let { runtimeBudgetHit, etherscanCircuitSkips } = scan;
  let tronLedgerUpdated = 0;
  let producerGapMetricSnapshots = 0;
  let producerSummarySnapshot = false;
  let producerSnapshotSkipped = false;
  let producerSnapshotError: string | null = null;
  let legacyIdentityMigration: BlacklistLegacyIdentityMigrationResult = {
    eventMigrated: 0,
    balanceMigrated: 0,
    ambiguousSkipped: 0,
  };
  let legacyIdentityMigrationError: string | null = null;
  let amountBackfill: BlacklistAmountBackfillResult = {
    runtimeBudgetReached: false,
    attempted: 0,
    resolved: 0,
    retried: 0,
    unrecoverable: 0,
  };

  // Historical amount repair and ledger mirroring are maintenance work. They
  // run only after every admissible event source has had its turn. A short,
  // separately capped tail window lets the durable repair queue make progress
  // after scan-budget exhaustion without taking time away from event scans.
  const scanBudgetExhausted = blacklistRuntimeBudgetReached(runBudget);
  if (etherscanCircuitAllowed && !blacklistRuntimeBudgetReached(maintenanceRunBudget)) {
    try {
      amountBackfill = await backfillAmounts(
        db,
        etherscanApiKey,
        drpcApiKey,
        etherscanLimiter,
        maintenanceRunBudget,
        signal,
        chainRpcs,
        scanBudgetExhausted ? { maxRows: BLACKLIST_AMOUNT_REPAIR_EXHAUSTED_SCAN_LIMIT } : undefined,
      );
      runtimeBudgetHit ||= amountBackfill.runtimeBudgetReached;
    } catch (err) {
      logWorkerEventArgs("handler", "warn", "[sync-blacklist] Backfill failed:", err);
    }
  } else if (!etherscanCircuitAllowed) {
    etherscanCircuitSkips++;
    logWorkerEventArgs("handler", "warn", "[sync-blacklist] Etherscan circuit open, skipping EVM amount backfill");
  }
  if (!blacklistRuntimeBudgetReached(maintenanceRunBudget)) {
    try {
      legacyIdentityMigration = await migrateLegacyBlacklistIdentities(db, signal);
    } catch (error) {
      legacyIdentityMigrationError = error instanceof Error ? error.name : "UnknownError";
      logWorkerEventArgs("handler", "warn", "[sync-blacklist] Legacy identity migration failed:", error);
    }
  }
  tronLedgerUpdated = await applyTronLedgerMirrorPass(db, "post-sync", {
    runBudget: maintenanceRunBudget,
    signal,
  });
  const subrequestBudgetReached = blacklistSubrequestBudgetReached(runBudget);
  const derivedStatus = deriveSyncBlacklistStatus(apiErrors, runtimeBudgetHit, {
    contractsSkipped,
    totalConfigs: configStates.length,
    incompleteRuntimeConfigs,
    subrequestBudgetHit: subrequestBudgetReached,
  });
  const { oldestSuccessAt, neverSucceeded } = getOldestBlacklistSuccessAt(configStates);
  const coverageFailures = Math.max(0, configsAttempted - configsSucceeded);
  const status: SyncBlacklistResult["status"] =
    derivedStatus === "ok" &&
    (providerCircuitSkips > 0 || coverageFailures > 0 || stateConflicts > 0 || neverSucceeded > 0)
      ? "degraded"
      : derivedStatus;
  const producerSnapshotWindowUnavailable =
    Date.now() + BLACKLIST_PRODUCER_SNAPSHOT_MIN_WINDOW_MS >= runBudget.deadlineMs;

  if (
    status !== "ok" ||
    blacklistRuntimeBudgetReached(runBudget) ||
    subrequestBudgetReached ||
    oldestSuccessAt == null ||
    producerSnapshotWindowUnavailable
  ) {
    producerSnapshotSkipped = true;
  } else {
    try {
      const snapshotNow = Math.floor(Date.now() / 1000);
      const gapSnapshot = await materializeBlacklistGapMetrics(db, snapshotNow, undefined, oldestSuccessAt);
      const summarySnapshot = await materializeBlacklistSummarySnapshot(db, snapshotNow, oldestSuccessAt);
      producerGapMetricSnapshots = gapSnapshot.written;
      producerSummarySnapshot = summarySnapshot.written;
    } catch (err) {
      producerSnapshotError = err instanceof Error ? err.name : "UnknownError";
      await reportCronProgress(
        onProgress,
        {
          stage: "producer-snapshots",
          itemsDone: configStates.length,
          itemsTotal: configStates.length,
          message: "Failed to materialize blacklist producer snapshots",
          metadata: {
            producerSnapshotError,
            errorMessage: toErrorMessage(err),
          },
        },
        budget,
      );
    }
  }

  logWorkerEventArgs("handler", "info", `[sync-blacklist] Completed with ${budget.count}/${budget.limit} subrequests`);
  await reportCronProgress(
    onProgress,
    {
      stage: "complete",
      itemsDone: configStates.length,
      itemsTotal: configStates.length,
      message: "Completed blacklist sync",
      metadata: {
        rowsWritten: counters.totalInsertedRows,
        eventsFetched: totalFetchedEvents,
        contractsSkipped,
        apiErrors,
        configsAttempted,
        configsSucceeded,
        coverageFailures,
        stateConflicts,
      },
    },
    budget,
  );
  return {
    status,
    itemCount: counters.totalInsertedRows,
    metadata: JSON.stringify(
      withBudgetMetadata(budget, {
        rowsWritten: counters.totalInsertedRows,
        eventsFetched: totalFetchedEvents,
        contractsSkipped,
        apiErrors,
        apiErrorConfigs,
        zeroCursorConfigCount: zeroCursorConfigs.length,
        zeroCursorConfigs: zeroCursorConfigs.slice(0, 10),
        configsAttempted,
        configsSucceeded,
        coverageFailures,
        stateConflicts,
        rpcLogConfigs,
        providerCircuitSkips,
        etherscanCircuitSkips,
        tronGridCircuitSkips,
        apiErrorClasses,
        coverageOutcomeCounts,
        blacklistProviderCalls,
        maxProviderSplitDepth,
        providerLimiterLiveConcurrency: BLACKLIST_PROVIDER_LIVE_CONCURRENCY,
        providerLimiterRequestsPerSecond: BLACKLIST_PROVIDER_REQUESTS_PER_SECOND,
        legacyIdentityEventMigrated: legacyIdentityMigration.eventMigrated,
        legacyIdentityBalanceMigrated: legacyIdentityMigration.balanceMigrated,
        legacyIdentityAmbiguousSkipped: legacyIdentityMigration.ambiguousSkipped,
        legacyIdentityMigrationError,
        amountRepairAttempted: amountBackfill.attempted,
        amountRepairResolved: amountBackfill.resolved,
        amountRepairRetried: amountBackfill.retried,
        amountRepairUnrecoverable: amountBackfill.unrecoverable,
        amountRepairTailWindowUsed: scanBudgetExhausted,
        amountRepairTailLimit: scanBudgetExhausted ? BLACKLIST_AMOUNT_REPAIR_EXHAUSTED_SCAN_LIMIT : 100,
        maintenanceRuntimeBudgetMs: SYNC_BLACKLIST_MAINTENANCE_BUDGET_MS,
        runtimeBudgetReached: runtimeBudgetHit,
        subrequestBudgetReached,
        runtimeBudgetMs: SYNC_BLACKLIST_RUNTIME_BUDGET_MS,
        incompleteRuntimeConfigs,
        oldestConfigSuccessAt: oldestSuccessAt,
        oldestConfigSuccessAgeSec:
          oldestSuccessAt == null ? null : Math.max(0, Math.floor(Date.now() / 1000) - oldestSuccessAt),
        configsNeverSucceeded: neverSucceeded,
        enrichAttempted: counters.enrichCounters.attempted,
        enrichSucceeded: counters.enrichCounters.succeeded,
        enrichFailed: counters.enrichCounters.failed,
        currentBalanceCacheUpdated: counters.currentBalanceCacheCounters.updated,
        currentBalanceCacheDeleted: counters.currentBalanceCacheCounters.deleted,
        currentBalanceCacheFailed: counters.currentBalanceCacheCounters.failed,
        tronLedgerUpdated,
        producerGapMetricSnapshots,
        producerSummarySnapshot,
        producerSnapshotSkipped,
        producerSnapshotError,
        producerSnapshotWindowMs: BLACKLIST_PRODUCER_SNAPSHOT_MIN_WINDOW_MS,
        producerSnapshotWindowUnavailable,
      }),
    ),
  };
}
