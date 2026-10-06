import { logWorkerEventArgs } from "../lib/structured-log";
import { toErrorMessage } from "@shared/lib/error-utils";
import type { CronProgressReporter, CronResult } from "../lib/cron-logger";
import { throwIfAborted } from "../lib/abort";
import { getReserveAdapter, type AdapterContext, type AdapterResult, type ReserveAdapterDefinition } from "./reserve-adapters/index";
import { reportCronProgress } from "../lib/cron-progress";
import {
  loadReserveSyncStateMap,
  type ReserveSyncStateRecord,
} from "../lib/live-reserves/store";
import {
  createAdapterLatencyCollector,
  syncReserveCoin,
  type AdapterLatencyCollector,
  type AdapterTelemetryProgress,
} from "./sync-live-reserves-core";
import {
  breakerKeyForConfig,
  CONFIGURED_COINS,
  SYNC_ORDERED_CONFIGURED_COINS,
  type ConfiguredCoin,
  type LiveReserveBreakerOutcome,
  type LiveReserveConfig,
  type LiveReserveDeferredTailOutcome,
  type LiveReservePhaseTimings,
  type LiveReserveQueueCounts,
  LIVE_RESERVE_QUEUE_HASH,
} from "./sync-live-reserves-shared";
import { finalizeReserveSyncRun, type ReserveSyncAttemptFailureGroup } from "./sync-live-reserves-finalize";
import { createReserveAdapterRunner } from "./reserve-adapter-runner";
export { createReserveAdapterRunner } from "./reserve-adapter-runner";
import {
  recordDeferredTail,
  selectConfiguredCoinRunQueue,
} from "./sync-live-reserves-run-state";
import {
  resolveLiveReserveSyncBudgetConfig,
  type LiveReserveSyncBudgetConfig,
} from "./sync-live-reserves-config";
import {
  advanceLiveReserveCheckpoint,
  loadLiveReserveCheckpoint,
  markLiveReserveCheckpointItemStarted,
  type ScheduledCheckpointIdentity,
} from "../lib/scheduled-recovery-checkpoint";
import {
  didReserveSyncAttemptBecomeAuthoritative,
} from "../lib/live-reserves/store";

interface ReserveCoinQueueResult {
  counts: LiveReserveQueueCounts;
  warningMessages: string[];
  coinsWithErrors: string[];
  coinsWithWarnings: string[];
  breaker: LiveReserveBreakerOutcome;
  deferredTail: LiveReserveDeferredTailOutcome;
  attemptFailureSummaries: ReserveSyncAttemptFailureGroup[];
  phaseTimings: Pick<LiveReservePhaseTimings, "adapter" | "d1CoinPersistence" | "stages">;
}

async function reportLiveReserveProgress(
  reportProgress: CronProgressReporter | undefined,
  update: {
    stage: string;
    message: string;
    itemsDone: number;
    itemsTotal: number;
    synced: number;
    failed: number;
    skipped: number;
    currentCoinId?: string;
    currentAdapter?: string;
    currentBreakerKey?: string;
    adapterTelemetryProgress: AdapterTelemetryProgress;
  },
): Promise<void> {
  await reportCronProgress(reportProgress, {
    stage: update.stage,
    message: update.message,
    itemsDone: update.itemsDone,
    itemsTotal: update.itemsTotal,
    metadata: {
      synced: update.synced,
      failed: update.failed,
      skipped: update.skipped,
      adapterTelemetryProgress: update.adapterTelemetryProgress,
      ...(update.currentCoinId ? { currentCoinId: update.currentCoinId } : {}),
      ...(update.currentAdapter ? { currentAdapter: update.currentAdapter } : {}),
      ...(update.currentBreakerKey ? { currentBreakerKey: update.currentBreakerKey } : {}),
    },
  });
}

interface RequestCachePromiseState {
  unsettledReorders: number;
  settled: boolean;
}

/**
 * Observes the existing request-cache Map protocol without changing request
 * labels or adding work to adapters. A miss is a newly inserted promise. A
 * hit is the delete/reinsert LRU move performed for an existing promise; the
 * one success-settlement reorder is excluded from the hit total.
 */
class InstrumentedRequestCache extends Map<string, Promise<unknown>> {
  private readonly backing: Map<string, Promise<unknown>>;
  private readonly collector: AdapterLatencyCollector;
  private readonly promiseStates = new WeakMap<Promise<unknown>, RequestCachePromiseState>();
  private readonly lastDeleted = new Map<string, Promise<unknown>>();

  constructor(backing: Map<string, Promise<unknown>>, collector: AdapterLatencyCollector) {
    super();
    this.backing = backing;
    this.collector = collector;
    for (const [key, promise] of backing) {
      super.set(key, promise);
      this.observePromise(promise, false);
    }
  }

  private observePromise(promise: Promise<unknown>, countMiss: boolean): RequestCachePromiseState {
    const existing = this.promiseStates.get(promise);
    if (existing) return existing;

    const state: RequestCachePromiseState = { unsettledReorders: 0, settled: false };
    this.promiseStates.set(promise, state);
    if (countMiss) this.collector.recordRequestCacheMiss();
    void promise.then(
      () => {
        state.settled = true;
        for (let index = 1; index < state.unsettledReorders; index++) {
          this.collector.recordRequestCacheHit();
        }
      },
      () => {
        state.settled = true;
        for (let index = 0; index < state.unsettledReorders; index++) {
          this.collector.recordRequestCacheHit();
        }
      },
    );
    return state;
  }

  override set(key: string, promise: Promise<unknown>): this {
    const state = this.observePromise(promise, !this.promiseStates.has(promise));
    if (this.lastDeleted.get(key) === promise) {
      if (state.settled) {
        this.collector.recordRequestCacheHit();
      } else {
        state.unsettledReorders += 1;
      }
      this.lastDeleted.delete(key);
    }
    super.set(key, promise);
    this.backing.set(key, promise);
    return this;
  }

  override delete(key: string): boolean {
    const promise = super.get(key);
    const deleted = super.delete(key);
    this.backing.delete(key);
    if (deleted && promise) this.lastDeleted.set(key, promise);
    return deleted;
  }

  override clear(): void {
    super.clear();
    this.backing.clear();
    this.lastDeleted.clear();
  }
}

async function runReserveCoinQueue(args: {
  db: D1Database;
  signal: AbortSignal;
  orderedCoins: readonly ConfiguredCoin[];
  runStartedMs: number;
  runAdapter: (
    coin: ConfiguredCoin,
    config: LiveReserveConfig,
    adapter: ReserveAdapterDefinition,
    deadlineMs?: number,
  ) => Promise<AdapterResult>;
  syncStates: Map<string, ReserveSyncStateRecord>;
  budgetConfig: LiveReserveSyncBudgetConfig;
  reportProgress?: CronProgressReporter;
  checkpoint?: ScheduledCheckpointIdentity;
  startIndex: number;
  fullQueue: readonly ConfiguredCoin[];
  telemetry: AdapterLatencyCollector;
}): Promise<ReserveCoinQueueResult> {
  const counts: LiveReserveQueueCounts = {
    synced: 0,
    failed: 0,
    skipped: 0,
    circuitSkipped: 0,
    deferredSkipped: 0,
    deferredCoins: 0,
    attemptedCoins: 0,
  };
  let deferredTail: LiveReserveDeferredTailOutcome = {
    nextCursorStablecoinId: null,
    cursorTailState: null,
    cursorRecordedAt: null,
    cursorTailCompletedAt: null,
    cursorTailFailedAt: null,
    cursorTailError: null,
    runBudgetTruncationCount: 0,
  };
  const warningMessages: string[] = [];
  const coinsWithErrors: string[] = [];
  const coinsWithWarnings: string[] = [];
  const attemptFailureSummaries: ReserveCoinQueueResult["attemptFailureSummaries"] = [];
  const breakerKeys = new Set<string>();
  const breakerOutcomes = new Map<string, boolean>();
  const breakerCanFetch = new Map<string, boolean>();
  const total = args.orderedCoins.length;
  const phaseTimings = { adapter: 0, d1CoinPersistence: 0, stages: {
    checkpoint: 0, breakerRead: 0, beginWrite: 0, failureWrite: 0, authoritativeWrite: 0, progress: 0,
  } };
  let lastProgressAtMs = 0;
  let lastProgressItemsDone = -1;
  let checkpointBoundaryAdvanced = false;

  for (const [index, coin] of args.orderedCoins.entries()) {
    throwIfAborted(args.signal);
    const globalIndex = args.startIndex + index;
    const budgetRemaining = args.budgetConfig.runBudgetMs - (Date.now() - args.runStartedMs);
    if (budgetRemaining < args.budgetConfig.minimumAttemptBudgetMs) {
      logWorkerEventArgs("handler", "warn",
        `[sync-live-reserves] Run budget exhausted at coin ${index}/${total}, deferring remaining`,
      );
      if (args.checkpoint) {
        const checkpointStartedMs = Date.now();
        await advanceLiveReserveCheckpoint(args.db, args.checkpoint, {
          nextItemKey: coin.id,
          itemsDone: globalIndex,
          ...(args.checkpoint.attemptNo > 1
            ? { recoveryLeaseUntil: Math.floor(Date.now() / 1000) + 15 * 60 }
            : {}),
        });
        phaseTimings.stages.checkpoint += Date.now() - checkpointStartedMs;
        checkpointBoundaryAdvanced = true;
      }
      const remainingCoins = args.orderedCoins.slice(index);
      const attemptedAt = Math.floor(Date.now() / 1000);
      try {
        const deferred = await recordDeferredTail(
          args.db,
          remainingCoins,
          attemptedAt,
          args.signal,
        );
        for (const key of deferred.additionalBreakerKeys) {
          breakerKeys.add(key);
        }
        counts.deferredCoins = deferred.counts.deferredCoins;
        deferredTail = deferred.deferredTail;
      } catch (error) {
        for (const remaining of remainingCoins) {
          breakerKeys.add(breakerKeyForConfig(remaining.liveReservesConfig!));
        }
        counts.deferredCoins = remainingCoins.length;
        deferredTail = {
          nextCursorStablecoinId: remainingCoins[0]?.id ?? null,
          cursorTailState: "incomplete",
          cursorRecordedAt: attemptedAt,
          cursorTailCompletedAt: null,
          cursorTailFailedAt: Math.floor(Date.now() / 1000),
          cursorTailError: toErrorMessage(error),
          runBudgetTruncationCount: remainingCoins.length > 0 ? 1 : 0,
        };
      }
      counts.skipped += counts.deferredCoins;
      counts.deferredSkipped += counts.deferredCoins;
      break;
    }

    const config = coin.liveReservesConfig!;
    const breakerKey = breakerKeyForConfig(config);
    breakerKeys.add(breakerKey);

    const shouldReportProgress =
      index === 0
      || globalIndex - lastProgressItemsDone >= 10
      || Date.now() - lastProgressAtMs >= 15_000;
    if (shouldReportProgress) {
      const progressStartedMs = Date.now();
      await reportLiveReserveProgress(args.reportProgress, {
        stage: "syncing",
        message: `Syncing ${coin.id}`,
        itemsDone: globalIndex,
        itemsTotal: args.fullQueue.length,
        synced: counts.synced,
        failed: counts.failed,
        skipped: counts.skipped,
        currentCoinId: coin.id,
        currentAdapter: config.adapter,
        currentBreakerKey: breakerKey,
        adapterTelemetryProgress: args.telemetry.progress(),
      });
      lastProgressAtMs = Date.now();
      phaseTimings.stages.progress += Date.now() - progressStartedMs;
      lastProgressItemsDone = globalIndex;
    }

    const result = await syncReserveCoin({
      db: args.db,
      coin,
      signal: args.signal,
      adapter: getReserveAdapter(config.adapter),
      breakerCanFetch,
      runAdapter: (attemptCoin, attemptConfig, adapter, deadlineMs) =>
        args.runAdapter(attemptCoin, attemptConfig, adapter, (deadlineMs ?? Infinity) - args.budgetConfig.d1FinalizeTimeoutMs),
      previousState: args.syncStates.get(coin.id) ?? null,
      d1FinalizeTimeoutMs: args.budgetConfig.d1FinalizeTimeoutMs,
      deadlineMs: args.runStartedMs + args.budgetConfig.runBudgetMs - args.budgetConfig.finalizationMarginMs,
      checkpoint: args.checkpoint,
      stageTimings: phaseTimings.stages,
      ...(args.checkpoint
        ? {
            onAttemptStarted: (attemptId: string) =>
              markLiveReserveCheckpointItemStarted(args.db, args.checkpoint!, {
                itemKey: coin.id,
                domainAttemptId: attemptId,
                itemsDone: globalIndex,
                deadlineMs: args.runStartedMs + args.budgetConfig.runBudgetMs - args.budgetConfig.finalizationMarginMs,
                itemsTotal: args.fullQueue.length,
                ...(args.checkpoint!.attemptNo > 1
                  ? { recoveryLeaseUntil: Math.floor(Date.now() / 1000) + 15 * 60 }
                  : {}),
              }),
          }
        : {}),
    });
    counts.attemptedCoins++;
    phaseTimings.adapter += result.adapterDurationMs;
    phaseTimings.d1CoinPersistence += result.d1DurationMs;

    if (result.status === "synced") {
      counts.synced++;
      if (result.publishedAt != null) {
        counts.latestPublishedAt = Math.max(counts.latestPublishedAt ?? 0, result.publishedAt);
      }
    } else if (result.status === "skipped") {
      counts.skipped++;
      counts.circuitSkipped++;
    } else {
      counts.failed++;
      coinsWithErrors.push(coin.id);
      if (result.attemptFailureSummaries) {
        attemptFailureSummaries.push({
          stablecoinId: coin.id,
          adapter: config.adapter,
          attempts: result.attemptFailureSummaries,
        });
      }
    }

    if (result.hasWarnings) {
      coinsWithWarnings.push(coin.id);
      warningMessages.push(...result.warningMessages);
    }

    if (
      result.breakerOutcome === false
      || (result.breakerOutcome === true && breakerOutcomes.get(breakerKey) !== false)
    ) {
      breakerOutcomes.set(breakerKey, result.breakerOutcome);
    }

  }

  if (args.checkpoint && args.orderedCoins.length > 0 && !checkpointBoundaryAdvanced) {
    const checkpointStartedMs = Date.now();
    await advanceLiveReserveCheckpoint(args.db, args.checkpoint, {
      nextItemKey: null,
      itemsDone: args.startIndex + args.orderedCoins.length,
      ...(args.checkpoint.attemptNo > 1
        ? { recoveryLeaseUntil: Math.floor(Date.now() / 1000) + 15 * 60 }
        : {}),
    });
    phaseTimings.stages.checkpoint += Date.now() - checkpointStartedMs;
  }

  return {
    counts,
    warningMessages,
    coinsWithErrors,
    coinsWithWarnings,
    breaker: { breakerKeys, breakerOutcomes },
    deferredTail,
    attemptFailureSummaries,
    phaseTimings,
  };
}

export async function syncLiveReserves(
  db: D1Database,
  signal: AbortSignal,
  adapterCtx?: AdapterContext,
  reportProgress?: CronProgressReporter,
  budgetOverrides?: Partial<LiveReserveSyncBudgetConfig>,
  checkpointIdentity?: ScheduledCheckpointIdentity,
): Promise<CronResult> {
  const runStartedAt = Math.floor(Date.now() / 1000);
  const runStartedMs = Date.now();
  const budgetConfig = resolveLiveReserveSyncBudgetConfig(budgetOverrides);
  let checkpoint = checkpointIdentity
    ? await loadLiveReserveCheckpoint(db, checkpointIdentity)
    : null;
  if (checkpointIdentity && !checkpoint) {
    throw new Error("live reserve checkpoint missing");
  }
  if (checkpoint && checkpoint.queueHash !== LIVE_RESERVE_QUEUE_HASH) {
    throw new Error(
      `live reserve queue hash changed (${checkpoint.queueHash} -> ${LIVE_RESERVE_QUEUE_HASH}); refusing unsafe suffix replay`,
    );
  }
  let checkpointResumeId = checkpoint?.nextItemKey ?? null;
  if (checkpoint && checkpointResumeId && checkpoint.currentDomainAttemptId) {
    const authoritative = await didReserveSyncAttemptBecomeAuthoritative(
      db,
      checkpointResumeId,
      checkpoint.currentDomainAttemptId,
    );
    if (authoritative) {
      const completedIndex = SYNC_ORDERED_CONFIGURED_COINS.findIndex((coin) => coin.id === checkpointResumeId);
      if (completedIndex < 0) {
        throw new Error(`live reserve checkpoint item ${checkpointResumeId} no longer exists in the queue`);
      }
      checkpointResumeId = SYNC_ORDERED_CONFIGURED_COINS[completedIndex + 1]?.id ?? null;
      await advanceLiveReserveCheckpoint(db, checkpointIdentity!, {
        nextItemKey: checkpointResumeId,
        itemsDone: completedIndex + 1,
        ...(checkpoint.attemptNo > 1
          ? { recoveryLeaseUntil: Math.floor(Date.now() / 1000) + 15 * 60 }
          : {}),
      });
      checkpoint = { ...checkpoint, nextItemKey: checkpointResumeId, currentDomainAttemptId: null, itemsDone: completedIndex + 1 };
    }
  }
  // A checkpoint's next-item pointer is the sole run-level resume mechanism.
  // A resumed run processes only the deferred suffix and does not wrap back to
  // the high-priority head; once the suffix completes, checkpoint finalization
  // clears the pointer and the next scheduled run starts from the queue head.
  const fullQueueTotal = SYNC_ORDERED_CONFIGURED_COINS.length;
  const checkpointResumeIndex = checkpointResumeId
    ? SYNC_ORDERED_CONFIGURED_COINS.findIndex((coin) => coin.id === checkpointResumeId)
    : checkpoint && checkpoint.itemsDone >= fullQueueTotal
      ? fullQueueTotal
      : 0;
  if (checkpointResumeId && checkpointResumeIndex < 0) {
    throw new Error(`live reserve checkpoint item ${checkpointResumeId} no longer exists in the queue`);
  }
  const startIndex = checkpointResumeIndex;
  const effectiveResumeId = startIndex > 0
    ? SYNC_ORDERED_CONFIGURED_COINS[startIndex]?.id ?? null
    : null;
  const orderedCoins = startIndex >= fullQueueTotal
    ? []
    : selectConfiguredCoinRunQueue(SYNC_ORDERED_CONFIGURED_COINS, effectiveResumeId);
  const syncStates = await loadReserveSyncStateMap(db, CONFIGURED_COINS.map((coin) => coin.id));
  const setupPhaseMs = Date.now() - runStartedMs;
  const telemetry = createAdapterLatencyCollector();
  const requestCache = new InstrumentedRequestCache(
    adapterCtx?.requestCache ?? new Map<string, Promise<unknown>>(),
    telemetry,
  );
  const effectiveAdapterCtx: AdapterContext = {
    db,
    ...(adapterCtx ?? {}),
    requestCache,
  };
  const cohortTotal = orderedCoins.length;

  await reportLiveReserveProgress(reportProgress, {
    stage: "setup",
    message: effectiveResumeId
      ? `Loaded live reserve sync state (resuming at ${effectiveResumeId})`
      : "Loaded live reserve sync state",
    itemsDone: Math.max(0, startIndex),
    itemsTotal: fullQueueTotal,
    synced: 0,
    failed: 0,
    skipped: 0,
    adapterTelemetryProgress: telemetry.progress(),
  });

  const runAdapter = createReserveAdapterRunner({
    signal,
    adapterCtx: effectiveAdapterCtx,
    adapterTimeoutMs: budgetConfig.adapterTimeoutMs,
    telemetry,
  });
  const queueResult = await runReserveCoinQueue({
    db,
    signal,
    orderedCoins,
    runStartedMs,
    runAdapter,
    syncStates,
    budgetConfig,
    reportProgress,
    checkpoint: checkpointIdentity,
    startIndex: Math.max(0, startIndex),
    fullQueue: SYNC_ORDERED_CONFIGURED_COINS,
    telemetry,
  });

  return finalizeReserveSyncRun({
    db,
    signal,
    total: cohortTotal,
    runStartedAt,
    runStartedMs,
    reportProgress,
    budgetConfig,
    ...queueResult,
    phaseTimings: {
      setup: setupPhaseMs,
      queue: Date.now() - runStartedMs - setupPhaseMs,
      ...queueResult.phaseTimings,
    },
    cohortItemsDoneBeforeRun: Math.max(0, startIndex),
    checkpointOwned: checkpointIdentity != null,
    adapterLatency: telemetry.finalize(),
    adapterTelemetryProgress: telemetry.progress(),
  });
}
