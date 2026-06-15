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
} from "./sync-live-reserves-shared";
import { finalizeReserveSyncRun, type ReserveSyncAttemptFailureGroup } from "./sync-live-reserves-finalize";
import { createAdapterIoLimiter, RESERVE_ADAPTER_MAX_PARALLEL_IO } from "./reserve-adapters/concurrency";
import {
  loadLiveReserveCursorState,
  recordDeferredTail,
  rotateConfiguredCoins,
  type LiveReserveCursorTailState,
  type LoadedLiveReserveCursorState,
} from "./sync-live-reserves-run-state";
import {
  resolveLiveReserveSyncBudgetConfig,
  type LiveReserveSyncBudgetConfig,
} from "./sync-live-reserves-config";

interface ReserveCoinQueueResult {
  synced: number;
  failed: number;
  skipped: number;
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
}): Promise<ReserveCoinQueueResult> {
  let synced = 0;
  let failed = 0;
  let skipped = 0;
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

  for (const [index, coin] of args.orderedCoins.entries()) {
    if (args.signal.aborted) throw args.signal.reason ?? new Error("sync-live-reserves aborted");
    const budgetRemaining = args.budgetConfig.runBudgetMs - (Date.now() - args.runStartedMs);
    if (budgetRemaining < args.budgetConfig.minimumAttemptBudgetMs) {
      console.warn(
        `[sync-live-reserves] Run budget exhausted at coin ${index}/${total}, deferring remaining`,
      );
      const deferred = await recordDeferredTail(
        args.db,
        args.orderedCoins.slice(index),
        Math.floor(Date.now() / 1000),
        args.signal,
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
      break;
    }

    const config = coin.liveReservesConfig!;
    const breakerKey = breakerKeyForConfig(config);
    breakerKeys.add(breakerKey);

    await reportLiveReserveProgress(args.reportProgress, {
      stage: "syncing",
      message: `Syncing ${coin.id}`,
      itemsDone: index,
      itemsTotal: total,
      synced,
      failed,
      skipped,
      currentCoinId: coin.id,
      currentAdapter: config.adapter,
      currentBreakerKey: breakerKey,
    });

    const result = await syncReserveCoin({
      db: args.db,
      coin,
      signal: args.signal,
      adapter: getReserveAdapter(config.adapter),
      runAdapter: args.runAdapter,
      breakerCanFetch,
      previousState: args.syncStates.get(coin.id) ?? null,
      d1FinalizeTimeoutMs: args.budgetConfig.d1FinalizeTimeoutMs,
    });

    if (result.status === "synced") {
      synced++;
    } else if (result.status === "skipped") {
      skipped++;
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

  return {
    synced,
    failed,
    skipped,
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
  };
}

export async function syncLiveReserves(
  db: D1Database,
  signal: AbortSignal,
  adapterCtx?: AdapterContext,
  reportProgress?: CronProgressReporter,
  budgetOverrides?: Partial<LiveReserveSyncBudgetConfig>,
): Promise<CronResult> {
  const runStartedAt = Math.floor(Date.now() / 1000);
  const runStartedMs = Date.now();
  const budgetConfig = resolveLiveReserveSyncBudgetConfig(budgetOverrides);
  const cursorState: LoadedLiveReserveCursorState | null = await loadLiveReserveCursorState(db);
  // Cursor rotation semantics over the evidence-class-ordered queue: a
  // cursored run rotates the full ordered queue to start at the first coin
  // deferred by the previous run, processes that deferred tail first, then
  // wraps around to the head until the budget is spent. Because any coin
  // deferred in run N sits at the front of run N+1's queue, the weak-probe
  // tail cannot starve indefinitely and a deferred independent coin is synced
  // on the very next run. If the cursor coin is no longer in the queue (order
  // or coverage changed between deploys), rotateFromCursor falls back to
  // starting from the top of the ordered queue.
  const orderedCoins = rotateConfiguredCoins(SYNC_ORDERED_CONFIGURED_COINS, cursorState?.nextStablecoinId ?? null);
  const syncStates = await loadReserveSyncStateMap(db, CONFIGURED_COINS.map((coin) => coin.id));
  const effectiveAdapterCtx: AdapterContext = {
    db,
    ...(adapterCtx ?? {}),
    nowSec: runStartedAt,
    requestCache: adapterCtx?.requestCache ?? new Map<string, Promise<unknown>>(),
  };
  const total = orderedCoins.length;

  await reportLiveReserveProgress(reportProgress, {
    stage: "setup",
    message: cursorState?.nextStablecoinId
      ? `Loaded live reserve sync state (resuming at ${cursorState.nextStablecoinId})`
      : "Loaded live reserve sync state",
    itemsDone: 0,
    itemsTotal: total,
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
  });

  return finalizeReserveSyncRun({
    db,
    signal,
    total,
    runStartedAt,
    reportProgress,
    budgetConfig,
    loadedCursorState: cursorState,
    ...queueResult,
  });
}
