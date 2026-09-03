import { logWorkerEventArgs } from "../lib/structured-log";
import { toErrorMessage } from "@shared/lib/error-utils";
import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import type { CronProgressReporter, CronResult } from "../lib/cron-logger";
import { throwIfAborted } from "../lib/abort";
import { getReserveAdapter, type AdapterContext, type AdapterResult, type ReserveAdapterDefinition } from "./reserve-adapters/index";
import { reportCronProgress } from "../lib/cron-progress";
import {
  loadReserveSyncStateMap,
  type ReserveSyncStateRecord,
} from "../lib/live-reserves-store";
import {
  createAdapterLatencyCollector,
  syncReserveCoin,
  type AdapterLatencyCollector,
  type AdapterLatencyStage,
  type AdapterTelemetryProgress,
} from "./sync-live-reserves-core";
import {
  buildSharedSourceCacheKey,
  buildReserveAdapterAttemptChainError,
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
import { createAdapterIoLimiter, RESERVE_ADAPTER_MAX_PARALLEL_IO } from "./reserve-adapters/concurrency";
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
  repairAuthoritativeReserveSyncHistory,
} from "../lib/live-reserves-store";

interface ReserveCoinQueueResult {
  counts: LiveReserveQueueCounts;
  warningMessages: string[];
  coinsWithErrors: string[];
  coinsWithWarnings: string[];
  breaker: LiveReserveBreakerOutcome;
  deferredTail: LiveReserveDeferredTailOutcome;
  attemptFailureSummaries: ReserveSyncAttemptFailureGroup[];
  phaseTimings: Pick<LiveReservePhaseTimings, "adapter" | "d1CoinPersistence">;
}

function createAbortableAttemptSignal(
  parentSignal: AbortSignal,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const timeout = createTimeoutSignal({
    timeoutMs,
    timeoutReason: new Error("adapter-timeout"),
    parentSignal,
  });
  const cleanup = () => timeout.dispose();

  return { signal: timeout.signal, cleanup };
}

function abortReason(signal: AbortSignal, fallback: string): Error | DOMException {
  const reason = signal.reason;
  if (reason instanceof Error || reason instanceof DOMException) return reason;
  if (typeof reason === "string") return new Error(reason);
  return new Error(fallback);
}

async function raceWithAbortSignal<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  fallbackReason: string,
): Promise<T> {
  if (signal.aborted) throw abortReason(signal, fallbackReason);

  let cleanup = () => {};
  const abortPromise = new Promise<T>((_resolve, reject) => {
    const abort = () => reject(abortReason(signal, fallbackReason));
    cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
  });

  try {
    return await Promise.race([operation, abortPromise]);
  } finally {
    cleanup();
  }
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

function classifyAdapterAttemptChain(config: LiveReserveConfig): string {
  const chains = new Set<string>();
  const input = config.inputs.primary;
  if (input.kind === "onchain-evm") chains.add(input.chain);
  if (input.kind === "onchain-solana") chains.add("solana");

  const visit = (value: unknown, key?: string, depth = 0): void => {
    if (depth > 8 || value == null) return;
    if (key === "chain" && typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (/^[a-z0-9._-]+$/.test(normalized)) chains.add(normalized.slice(0, 80));
      return;
    }
    if (Array.isArray(value)) {
      for (const nested of value) visit(nested, undefined, depth + 1);
      return;
    }
    if (typeof value === "object") {
      for (const [nestedKey, nested] of Object.entries(value as Record<string, unknown>)) {
        visit(nested, nestedKey, depth + 1);
      }
    }
  };
  visit(config.params);

  if (chains.size > 1) return "multi";
  if (chains.size === 1) return chains.values().next().value!;
  return input.kind === "http-json" || input.kind === "http-html" || input.kind === "indexer"
    ? "offchain"
    : "multi";
}

async function runAdapterAttempt(
  coin: ConfiguredCoin,
  config: LiveReserveConfig,
  adapter: ReserveAdapterDefinition,
  signal: AbortSignal,
  adapterTimeoutMs: number,
  stage: AdapterLatencyStage,
  cacheHit: boolean,
  telemetry: AdapterLatencyCollector,
  adapterCtx?: AdapterContext,
): Promise<AdapterResult> {
  const { signal: attemptSignal, cleanup } = createAbortableAttemptSignal(signal, adapterTimeoutMs);
  const startedMs = Date.now();
  let ioCallCount = 0;
  let waveCount = 0;
  let activeIo = 0;
  let attemptErrored = true;
  const limiter = createAdapterIoLimiter(RESERVE_ADAPTER_MAX_PARALLEL_IO);
  const instrumentedLimiter = {
    run<T>(label: string, factory: () => Promise<T>, options?: { signal?: AbortSignal }): Promise<T> {
      ioCallCount += 1;
      return limiter.run(label, () => {
        if (activeIo === 0) waveCount += 1;
        activeIo += 1;
        try {
          const operation = factory();
          void operation.then(
            () => { activeIo -= 1; },
            () => { activeIo -= 1; },
          );
          return operation;
        } catch (error) {
          activeIo -= 1;
          throw error;
        }
      }, options);
    },
  };
  try {
    const result = await raceWithAbortSignal(
      adapter.fetch(coin, config, attemptSignal, Object.assign({}, adapterCtx, {
        abortSignal: attemptSignal,
        ioLimiter: instrumentedLimiter,
      })),
      attemptSignal,
      "adapter-timeout",
    );
    attemptErrored = false;
    return result;
  } finally {
    telemetry.recordAttempt({
      adapterKey: adapter.key,
      chain: classifyAdapterAttemptChain(config),
      stage,
      cacheHit,
      ioCallCount,
      waveCount,
      elapsedMs: Date.now() - startedMs,
      error: attemptErrored,
    });
    cleanup();
  }
}

function observeSharedAdapterResult(
  promise: Promise<AdapterResult>,
  input: {
    adapterKey: string;
    chain: string;
    telemetry: AdapterLatencyCollector;
  },
): Promise<AdapterResult> {
  const startedMs = Date.now();
  return promise.then(
    (result) => {
      input.telemetry.recordAttempt({
        adapterKey: input.adapterKey,
        chain: input.chain,
        stage: "primary",
        cacheHit: true,
        ioCallCount: 0,
        waveCount: 0,
        elapsedMs: Date.now() - startedMs,
        error: false,
      });
      return result;
    },
    (error) => {
      input.telemetry.recordAttempt({
        adapterKey: input.adapterKey,
        chain: input.chain,
        stage: "primary",
        cacheHit: true,
        ioCallCount: 0,
        waveCount: 0,
        elapsedMs: Date.now() - startedMs,
        error: true,
      });
      throw error;
    },
  );
}

function createReserveAdapterRunner(args: {
  signal: AbortSignal;
  adapterCtx: AdapterContext;
  adapterTimeoutMs: number;
  telemetry: AdapterLatencyCollector;
}): (
  coin: ConfiguredCoin,
  config: LiveReserveConfig,
  adapter: ReserveAdapterDefinition,
) => Promise<AdapterResult> {
  const sharedSourceResults = new Map<string, Promise<AdapterResult>>();

  const tryPrimary = (
    coin: ConfiguredCoin,
    config: LiveReserveConfig,
    adapter: ReserveAdapterDefinition,
  ): Promise<AdapterResult> => {
    const cacheKey = buildSharedSourceCacheKey(config, adapter);
    if (!cacheKey) {
      return runAdapterAttempt(
        coin,
        config,
        adapter,
        args.signal,
        args.adapterTimeoutMs,
        "primary",
        false,
        args.telemetry,
        args.adapterCtx,
      );
    }

    const cached = sharedSourceResults.get(cacheKey);
    if (cached) {
      return observeSharedAdapterResult(cached, {
        adapterKey: adapter.key,
        chain: classifyAdapterAttemptChain(config),
        telemetry: args.telemetry,
      });
    }

    // Retain the promise (including rejections) for the remainder of the run
    // so every coin sharing this source sees a single fetch outcome. The
    // circuit breaker handles cross-run retry suppression.
    const resultPromise = runAdapterAttempt(
      coin,
      config,
      adapter,
      args.signal,
      args.adapterTimeoutMs,
      "primary",
      false,
      args.telemetry,
      args.adapterCtx,
    );
    sharedSourceResults.set(cacheKey, resultPromise);
    return resultPromise;
  };

  return async (
    coin: ConfiguredCoin,
    config: LiveReserveConfig,
    adapter: ReserveAdapterDefinition,
  ): Promise<AdapterResult> => {
    try {
      return await tryPrimary(coin, config, adapter);
    } catch (primaryError) {
      const fallbackAttempts: Array<{
        input: LiveReserveConfig["inputs"]["primary"];
        error: unknown;
        index: number;
      }> = [];
      for (const fb of config.inputs.fallbacks ?? []) {
        throwIfAborted(args.signal);
        try {
          const fbConfig = { ...config, inputs: { ...config.inputs, primary: fb } };
          const fallbackResult = await runAdapterAttempt(
            coin,
            fbConfig,
            adapter,
            args.signal,
            args.adapterTimeoutMs,
            "fallback",
            false,
            args.telemetry,
            args.adapterCtx,
          );
          const primaryMessage = toErrorMessage(primaryError);
          const truncated = primaryMessage.length > 200
            ? `${primaryMessage.slice(0, 200)}…`
            : primaryMessage;
          const fallbackWarning = {
            code: "primary-fallback-used",
            message: `Primary reserve source failed; fell through to fallback. Primary error: ${truncated}`,
            severity: "info" as const,
            effect: "info" as const,
          };
          return {
            ...fallbackResult,
            warnings: [...(fallbackResult.warnings ?? []), fallbackWarning],
          };
        } catch (error) {
          fallbackAttempts.push({ input: fb, error, index: fallbackAttempts.length });
          logWorkerEventArgs("handler", "warn", `[sync-live-reserves] Fallback failed for ${coin.id}:`, error);
        }
      }
      throw buildReserveAdapterAttemptChainError(config, primaryError, fallbackAttempts);
    }
  };
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
  const phaseTimings = { adapter: 0, d1CoinPersistence: 0 };
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
        await advanceLiveReserveCheckpoint(args.db, args.checkpoint, {
          nextItemKey: coin.id,
          itemsDone: globalIndex,
          ...(args.checkpoint.attemptNo > 1
            ? { recoveryLeaseUntil: Math.floor(Date.now() / 1000) + 15 * 60 }
            : {}),
        });
        checkpointBoundaryAdvanced = true;
      }
      const deferred = await recordDeferredTail(
        args.db,
        args.orderedCoins.slice(index),
        Math.floor(Date.now() / 1000),
        args.signal,
      );
      for (const key of deferred.additionalBreakerKeys) {
        breakerKeys.add(key);
      }
      counts.deferredCoins = deferred.counts.deferredCoins;
      deferredTail = deferred.deferredTail;
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
      lastProgressItemsDone = globalIndex;
    }

    const result = await syncReserveCoin({
      db: args.db,
      coin,
      signal: args.signal,
      adapter: getReserveAdapter(config.adapter),
      runAdapter: args.runAdapter,
      breakerCanFetch,
      previousState: args.syncStates.get(coin.id) ?? null,
      d1FinalizeTimeoutMs: args.budgetConfig.d1FinalizeTimeoutMs,
      ...(args.checkpoint
        ? {
            onAttemptStarted: (attemptId: string) =>
              markLiveReserveCheckpointItemStarted(args.db, args.checkpoint!, {
                itemKey: coin.id,
                domainAttemptId: attemptId,
                itemsDone: globalIndex,
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
    await advanceLiveReserveCheckpoint(args.db, args.checkpoint, {
      nextItemKey: null,
      itemsDone: args.startIndex + args.orderedCoins.length,
      ...(args.checkpoint.attemptNo > 1
        ? { recoveryLeaseUntil: Math.floor(Date.now() / 1000) + 15 * 60 }
        : {}),
    });
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
      const historyRepaired = await repairAuthoritativeReserveSyncHistory(
        db,
        checkpointResumeId,
        checkpoint.currentDomainAttemptId,
      );
      if (!historyRepaired) {
        throw new Error(
          `live reserve checkpoint history repair lost authoritative generation for ${checkpointResumeId}`,
        );
      }
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
    nowSec: runStartedAt,
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
