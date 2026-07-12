import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import type { CronProgressReporter, CronResult } from "../lib/cron-logger";
import { throwIfAborted } from "../lib/abort";
import { getReserveAdapter, type AdapterContext, type AdapterResult, type ReserveAdapterDefinition } from "./reserve-adapters/index";
import { reportCronProgress } from "../lib/cron-progress";
import {
  loadReserveSyncStateMap,
  type ReserveSyncStateRecord,
} from "../lib/live-reserves-store";
import { syncReserveCoin } from "./sync-live-reserves-core";
import {
  buildSharedSourceCacheKey,
  buildReserveAdapterAttemptChainError,
  breakerKeyForConfig,
  CONFIGURED_COINS,
  SYNC_ORDERED_CONFIGURED_COINS,
  type ConfiguredCoin,
  type LiveReserveConfig,
  LIVE_RESERVE_QUEUE_HASH,
} from "./sync-live-reserves-shared";
import { finalizeReserveSyncRun, type ReserveSyncAttemptFailureGroup } from "./sync-live-reserves-finalize";
import { createAdapterIoLimiter, RESERVE_ADAPTER_MAX_PARALLEL_IO } from "./reserve-adapters/concurrency";
import {
  loadLiveReserveCursorState,
  recordDeferredTail,
  selectConfiguredCoinRunQueue,
  type LiveReserveGlobalCursorOwner,
  type LiveReserveCursorTailState,
  type LoadedLiveReserveCursorState,
} from "./sync-live-reserves-run-state";
import {
  resolveLiveReserveSyncBudgetConfig,
  type LiveReserveSyncBudgetConfig,
} from "./sync-live-reserves-config";
import {
  advanceScheduledCheckpoint,
  loadScheduledCheckpoint,
  markScheduledCheckpointItemStarted,
  type ScheduledCheckpointIdentity,
} from "../lib/scheduled-recovery-checkpoint";
import {
  didReserveSyncAttemptBecomeAuthoritative,
  repairAuthoritativeReserveSyncHistory,
} from "../lib/live-reserves-store";
import type { ReserveRecoveryFaultInjectionController } from "../lib/reserve-recovery-fault-injection";

interface ReserveCoinQueueResult {
  synced: number;
  failed: number;
  skipped: number;
  circuitSkipped: number;
  deferredSkipped: number;
  warningMessages: string[];
  coinsWithErrors: string[];
  coinsWithWarnings: string[];
  breakerKeys: Set<string>;
  breakerOutcomes: Map<string, boolean>;
  deferredCoins: number;
  nextCursorStablecoinId: string | null;
  cursorTailState: LiveReserveCursorTailState | null;
  cursorRecordedAt: number | null;
  cursorTailCompletedAt: number | null;
  cursorTailFailedAt: number | null;
  cursorTailError: string | null;
  runBudgetTruncationCount: number;
  attemptFailureSummaries: ReserveSyncAttemptFailureGroup[];
  attemptedCoins: number;
  adapterPhaseMs: number;
  d1PhaseMs: number;
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
      ...(update.currentCoinId ? { currentCoinId: update.currentCoinId } : {}),
      ...(update.currentAdapter ? { currentAdapter: update.currentAdapter } : {}),
      ...(update.currentBreakerKey ? { currentBreakerKey: update.currentBreakerKey } : {}),
    },
  });
}

async function runAdapterAttempt(
  coin: ConfiguredCoin,
  config: LiveReserveConfig,
  adapter: ReserveAdapterDefinition,
  signal: AbortSignal,
  adapterTimeoutMs: number,
  adapterCtx?: AdapterContext,
): Promise<AdapterResult> {
  const { signal: attemptSignal, cleanup } = createAbortableAttemptSignal(signal, adapterTimeoutMs);
  try {
    return await raceWithAbortSignal(
      adapter.fetch(coin, config, attemptSignal, Object.assign({}, adapterCtx, {
        abortSignal: attemptSignal,
        ioLimiter: createAdapterIoLimiter(RESERVE_ADAPTER_MAX_PARALLEL_IO),
      })),
      attemptSignal,
      "adapter-timeout",
    );
  } finally {
    cleanup();
  }
}

function createReserveAdapterRunner(args: {
  signal: AbortSignal;
  adapterCtx: AdapterContext;
  adapterTimeoutMs: number;
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
      return runAdapterAttempt(coin, config, adapter, args.signal, args.adapterTimeoutMs, args.adapterCtx);
    }

    const cached = sharedSourceResults.get(cacheKey);
    if (cached) return cached;

    // Retain the promise (including rejections) for the remainder of the run
    // so every coin sharing this source sees a single fetch outcome. The
    // circuit breaker handles cross-run retry suppression.
    const resultPromise = runAdapterAttempt(coin, config, adapter, args.signal, args.adapterTimeoutMs, args.adapterCtx);
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
            args.adapterCtx,
          );
          const primaryMessage = primaryError instanceof Error
            ? primaryError.message
            : String(primaryError);
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
          console.warn(`[sync-live-reserves] Fallback failed for ${coin.id}:`, error);
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
  faultInjection?: ReserveRecoveryFaultInjectionController | null;
  startIndex: number;
  fullQueue: readonly ConfiguredCoin[];
  manageGlobalCursor: boolean;
  globalCursorOwner: LiveReserveGlobalCursorOwner | null;
}): Promise<ReserveCoinQueueResult> {
  let synced = 0;
  let failed = 0;
  let skipped = 0;
  let circuitSkipped = 0;
  let deferredSkipped = 0;
  let deferredCoins = 0;
  let nextCursorStablecoinId: string | null = null;
  let cursorTailState: LiveReserveCursorTailState | null = null;
  let cursorRecordedAt: number | null = null;
  let cursorTailCompletedAt: number | null = null;
  let cursorTailFailedAt: number | null = null;
  let cursorTailError: string | null = null;
  let runBudgetTruncationCount = 0;
  const warningMessages: string[] = [];
  const coinsWithErrors: string[] = [];
  const coinsWithWarnings: string[] = [];
  const attemptFailureSummaries: ReserveCoinQueueResult["attemptFailureSummaries"] = [];
  const breakerKeys = new Set<string>();
  const breakerOutcomes = new Map<string, boolean>();
  const breakerCanFetch = new Map<string, boolean>();
  const total = args.orderedCoins.length;
  let attemptedCoins = 0;
  let adapterPhaseMs = 0;
  let d1PhaseMs = 0;
  let lastProgressAtMs = 0;
  let lastProgressItemsDone = -1;
  let checkpointBoundaryAdvanced = false;

  for (const [index, coin] of args.orderedCoins.entries()) {
    throwIfAborted(args.signal);
    const globalIndex = args.startIndex + index;
    const budgetRemaining = args.budgetConfig.runBudgetMs - (Date.now() - args.runStartedMs);
    if (budgetRemaining < args.budgetConfig.minimumAttemptBudgetMs) {
      console.warn(
        `[sync-live-reserves] Run budget exhausted at coin ${index}/${total}, deferring remaining`,
      );
      if (args.checkpoint) {
        await advanceScheduledCheckpoint(args.db, args.checkpoint, {
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
        {
          manageGlobalCursor: args.manageGlobalCursor,
          globalCursorOwner: args.globalCursorOwner,
        },
      );
      for (const key of deferred.additionalBreakerKeys) {
        breakerKeys.add(key);
      }
      deferredCoins = deferred.deferredCoins;
      nextCursorStablecoinId = deferred.nextCursorStablecoinId;
      cursorTailState = deferred.cursorTailState;
      cursorRecordedAt = deferred.cursorRecordedAt;
      cursorTailCompletedAt = deferred.cursorTailCompletedAt;
      cursorTailFailedAt = deferred.cursorTailFailedAt;
      cursorTailError = deferred.cursorTailError;
      runBudgetTruncationCount = deferred.runBudgetTruncationCount;
      skipped += deferredCoins;
      deferredSkipped += deferredCoins;
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
        synced,
        failed,
        skipped,
        currentCoinId: coin.id,
        currentAdapter: config.adapter,
        currentBreakerKey: breakerKey,
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
              markScheduledCheckpointItemStarted(args.db, args.checkpoint!, {
                itemKey: coin.id,
                domainAttemptId: attemptId,
                itemsDone: globalIndex,
                itemsTotal: args.fullQueue.length,
                ...(args.checkpoint!.attemptNo > 1
                  ? { recoveryLeaseUntil: Math.floor(Date.now() / 1000) + 15 * 60 }
                  : {}),
              }),
            onAttemptPending: () =>
              args.faultInjection?.trigger("after_pending_begin", coin.id) ?? Promise.resolve(),
            onAuthoritativeWrite: () =>
              args.faultInjection?.trigger("after_authoritative_write", coin.id) ?? Promise.resolve(),
          }
        : {}),
    });
    attemptedCoins++;
    adapterPhaseMs += result.adapterDurationMs;
    d1PhaseMs += result.d1DurationMs;

    if (result.status === "synced") {
      synced++;
    } else if (result.status === "skipped") {
      skipped++;
      circuitSkipped++;
    } else {
      failed++;
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
    await advanceScheduledCheckpoint(args.db, args.checkpoint, {
      nextItemKey: null,
      itemsDone: args.startIndex + args.orderedCoins.length,
      ...(args.checkpoint.attemptNo > 1
        ? { recoveryLeaseUntil: Math.floor(Date.now() / 1000) + 15 * 60 }
        : {}),
    });
  }

  return {
    synced,
    failed,
    skipped,
    circuitSkipped,
    deferredSkipped,
    warningMessages,
    coinsWithErrors,
    coinsWithWarnings,
    breakerKeys,
    breakerOutcomes,
    deferredCoins,
    nextCursorStablecoinId,
    cursorTailState,
    cursorRecordedAt,
    cursorTailCompletedAt,
    cursorTailFailedAt,
    cursorTailError,
    runBudgetTruncationCount,
    attemptFailureSummaries,
    attemptedCoins,
    adapterPhaseMs,
    d1PhaseMs,
  };
}

export async function syncLiveReserves(
  db: D1Database,
  signal: AbortSignal,
  adapterCtx?: AdapterContext,
  reportProgress?: CronProgressReporter,
  budgetOverrides?: Partial<LiveReserveSyncBudgetConfig>,
  checkpointIdentity?: ScheduledCheckpointIdentity,
  faultInjection?: ReserveRecoveryFaultInjectionController | null,
): Promise<CronResult> {
  const runStartedAt = Math.floor(Date.now() / 1000);
  const runStartedMs = Date.now();
  const budgetConfig = resolveLiveReserveSyncBudgetConfig(budgetOverrides);
  let checkpoint = checkpointIdentity
    ? await loadScheduledCheckpoint(db, checkpointIdentity)
    : null;
  if (checkpointIdentity && !checkpoint) {
    throw new Error("live reserve checkpoint missing");
  }
  if (checkpoint && checkpoint.queueHash !== LIVE_RESERVE_QUEUE_HASH) {
    throw new Error(
      `live reserve queue hash changed (${checkpoint.queueHash} -> ${LIVE_RESERVE_QUEUE_HASH}); refusing unsafe suffix replay`,
    );
  }
  const recoveryCheckpointOwned = checkpoint?.state === "recovering" || checkpoint?.sourceAttemptNo != null;
  const manageGlobalCursor = !recoveryCheckpointOwned;
  const checkpointCursorOwner: LiveReserveGlobalCursorOwner | null = checkpoint
    ? {
        scheduleKey: checkpoint.scheduleKey,
        slotStartedAt: checkpoint.slotStartedAt,
        attemptNo: checkpoint.attemptNo,
        executionGeneration: checkpoint.executionGeneration,
        invocationId: checkpoint.invocationId,
        queueHash: checkpoint.queueHash,
      }
    : null;
  const cursorState: LoadedLiveReserveCursorState | null = manageGlobalCursor
    ? await loadLiveReserveCursorState(db)
    : null;
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
      await advanceScheduledCheckpoint(db, checkpointIdentity!, {
        nextItemKey: checkpointResumeId,
        itemsDone: completedIndex + 1,
        ...(checkpoint.attemptNo > 1
          ? { recoveryLeaseUntil: Math.floor(Date.now() / 1000) + 15 * 60 }
          : {}),
      });
      checkpoint = { ...checkpoint, nextItemKey: checkpointResumeId, currentDomainAttemptId: null, itemsDone: completedIndex + 1 };
    }
  }
  // Cursor semantics over the evidence-class-ordered queue: a cursored run
  // resumes at the first coin deferred by the previous run and processes only
  // that deferred suffix. It deliberately does not wrap back to the
  // high-priority head in the same run; otherwise a slow weak-probe tail could
  // exhaust the resumed budget and rewrite independent head feeds as skipped.
  // Once the deferred suffix completes, finalization clears the cursor and the
  // next scheduled run starts again from the top of the priority queue. If the
  // cursor coin is no longer in the queue (order or coverage changed between
  // deploys), fall back to starting from the top of the ordered queue.
  const fullQueueTotal = SYNC_ORDERED_CONFIGURED_COINS.length;
  const checkpointResumeIndex = checkpointResumeId
    ? SYNC_ORDERED_CONFIGURED_COINS.findIndex((coin) => coin.id === checkpointResumeId)
    : checkpoint && checkpoint.itemsDone >= fullQueueTotal
      ? fullQueueTotal
      : 0;
  if (checkpointResumeId && checkpointResumeIndex < 0) {
    throw new Error(`live reserve checkpoint item ${checkpointResumeId} no longer exists in the queue`);
  }
  const globalResumeId = cursorState?.nextStablecoinId ?? null;
  const globalResumeIndex = globalResumeId
    ? SYNC_ORDERED_CONFIGURED_COINS.findIndex((coin) => coin.id === globalResumeId)
    : -1;
  const checkpointHasUnfinishedAttempt = checkpoint?.currentDomainAttemptId != null;
  const startIndex = recoveryCheckpointOwned || checkpointHasUnfinishedAttempt
    ? checkpointResumeIndex
    : Math.max(checkpointResumeIndex, Math.max(0, globalResumeIndex));
  const frontierItemId = SYNC_ORDERED_CONFIGURED_COINS[startIndex]?.id ?? null;
  if (
    checkpoint
    && manageGlobalCursor
    && (checkpoint.nextItemKey !== frontierItemId || checkpoint.itemsDone !== startIndex)
  ) {
    await advanceScheduledCheckpoint(db, checkpointIdentity!, {
      nextItemKey: frontierItemId,
      itemsDone: startIndex,
    });
    checkpoint = { ...checkpoint, nextItemKey: frontierItemId, itemsDone: startIndex };
  }
  const effectiveResumeId = startIndex > 0 ? frontierItemId : null;
  const orderedCoins = startIndex >= fullQueueTotal
    ? []
    : selectConfiguredCoinRunQueue(SYNC_ORDERED_CONFIGURED_COINS, effectiveResumeId);
  const syncStates = await loadReserveSyncStateMap(db, CONFIGURED_COINS.map((coin) => coin.id));
  const setupPhaseMs = Date.now() - runStartedMs;
  const effectiveAdapterCtx: AdapterContext = {
    db,
    ...(adapterCtx ?? {}),
    nowSec: runStartedAt,
    requestCache: adapterCtx?.requestCache ?? new Map<string, Promise<unknown>>(),
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
  });

  const runAdapter = createReserveAdapterRunner({
    signal,
    adapterCtx: effectiveAdapterCtx,
    adapterTimeoutMs: budgetConfig.adapterTimeoutMs,
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
    faultInjection,
    startIndex: Math.max(0, startIndex),
    fullQueue: SYNC_ORDERED_CONFIGURED_COINS,
    manageGlobalCursor,
    globalCursorOwner: manageGlobalCursor ? checkpointCursorOwner : null,
  });

  return finalizeReserveSyncRun({
    db,
    signal,
    total: cohortTotal,
    runStartedAt,
    runStartedMs,
    reportProgress,
    budgetConfig,
    loadedCursorState: cursorState,
    manageGlobalCursor,
    checkpointOwned: checkpoint != null,
    recoveryCursorOwner: recoveryCheckpointOwned ? checkpointCursorOwner : null,
    setupPhaseMs,
    queuePhaseMs: Date.now() - runStartedMs - setupPhaseMs,
    cohortItemsDoneBeforeRun: Math.max(0, startIndex),
    ...queueResult,
  });
}
