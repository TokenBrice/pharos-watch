import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import type { CronProgressReporter, CronResult } from "../lib/cron-logger";
import { getReserveAdapter, type AdapterContext, type AdapterResult, type ReserveAdapterDefinition } from "./reserve-adapters/index";
import { recordOutcomeSafe } from "../lib/circuit-breaker";
import { reportCronProgress } from "../lib/cron-progress";
import {
  cleanupStaleLiveReserveArtifacts,
  loadReserveSyncStateMap,
  pruneLiveReserveHistory,
  type ReserveSyncStateRecord,
} from "../lib/live-reserves-store";
import { syncReserveCoin } from "./sync-live-reserves-core";
import {
  buildSharedSourceCacheKey,
  buildReserveAdapterAttemptChainError,
  breakerKeyForConfig,
  CONFIGURED_COINS,
  type ConfiguredCoin,
  type LiveReserveConfig,
} from "./sync-live-reserves-shared";
import { createAdapterIoLimiter, RESERVE_ADAPTER_MAX_PARALLEL_IO } from "./reserve-adapters/concurrency";
import {
  loadLiveReserveCursorState,
  persistLiveReserveCursorState,
  recordDeferredTail,
  rotateConfiguredCoins,
} from "./sync-live-reserves-run-state";
const ADAPTER_TIMEOUT_MS = 20_000;
const SYNC_RUN_BUDGET_MS = 11 * 60 * 1000;

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
  const cleanup = () => {
    timeout.dispose();
  };

  return { signal: timeout.signal, cleanup };
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
  adapterCtx?: AdapterContext,
): Promise<AdapterResult> {
  const { signal: attemptSignal, cleanup } = createAbortableAttemptSignal(signal, ADAPTER_TIMEOUT_MS);
  try {
    return await adapter.fetch(coin, config, attemptSignal, Object.assign({}, adapterCtx, { ioLimiter: createAdapterIoLimiter(RESERVE_ADAPTER_MAX_PARALLEL_IO) }));
  } finally {
    cleanup();
  }
}

function createReserveAdapterRunner(args: {
  signal: AbortSignal;
  adapterCtx: AdapterContext;
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
      return runAdapterAttempt(coin, config, adapter, args.signal, args.adapterCtx);
    }

    const cached = sharedSourceResults.get(cacheKey);
    if (cached) return cached;

    // Retain the promise (including rejections) for the remainder of the run
    // so every coin sharing this source sees a single fetch outcome. The
    // circuit breaker handles cross-run retry suppression.
    const resultPromise = runAdapterAttempt(coin, config, adapter, args.signal, args.adapterCtx);
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
        try {
          const fbConfig = { ...config, inputs: { ...config.inputs, primary: fb } };
          const fallbackResult = await runAdapterAttempt(coin, fbConfig, adapter, args.signal, args.adapterCtx);
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
  reportProgress?: CronProgressReporter;
}): Promise<ReserveCoinQueueResult> {
  let synced = 0;
  let failed = 0;
  let skipped = 0;
  let deferredCoins = 0;
  let nextCursorStablecoinId: string | null = null;
  const warningMessages: string[] = [];
  const coinsWithErrors: string[] = [];
  const coinsWithWarnings: string[] = [];
  const breakerKeys = new Set<string>();
  const breakerOutcomes = new Map<string, boolean>();
  const breakerCanFetch = new Map<string, boolean>();
  const total = args.orderedCoins.length;

  for (const [index, coin] of args.orderedCoins.entries()) {
    if (args.signal?.aborted) throw args.signal.reason ?? new Error("sync-live-reserves aborted");
    const budgetRemaining = SYNC_RUN_BUDGET_MS - (Date.now() - args.runStartedMs);
    if (budgetRemaining < ADAPTER_TIMEOUT_MS) {
      console.warn(
        `[sync-live-reserves] Run budget exhausted at coin ${index}/${total}, deferring remaining`,
      );
      const deferred = await recordDeferredTail(
        args.db,
        args.orderedCoins.slice(index),
        breakerKeys,
        Math.floor(Date.now() / 1000),
      );
      deferredCoins = deferred.deferredCoins;
      nextCursorStablecoinId = deferred.nextCursorStablecoinId;
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
    });

    if (result.status === "synced") {
      synced++;
    } else if (result.status === "skipped") {
      skipped++;
    } else {
      failed++;
      coinsWithErrors.push(coin.id);
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
  };
}

async function finalizeReserveSyncRun(args: {
  db: D1Database;
  total: number;
  runStartedAt: number;
  reportProgress?: CronProgressReporter;
  synced: number;
  failed: number;
  skipped: number;
  warningMessages: string[];
  coinsWithErrors: string[];
  coinsWithWarnings: string[];
  breakerKeys: ReadonlySet<string>;
  breakerOutcomes: ReadonlyMap<string, boolean>;
  deferredCoins: number;
  nextCursorStablecoinId: string | null;
}): Promise<CronResult> {
  await reportLiveReserveProgress(args.reportProgress, {
    stage: "finalizing",
    message: "Recording reserve sync outcomes and cleanup",
    itemsDone: args.total,
    itemsTotal: args.total,
    synced: args.synced,
    failed: args.failed,
    skipped: args.skipped,
  });

  // Deferred breaker outcome recording: worst outcome per key wins.
  for (const [key, success] of args.breakerOutcomes) {
    await recordOutcomeSafe(args.db, key, success);
  }

  try {
    await cleanupStaleLiveReserveArtifacts(
      args.db,
      CONFIGURED_COINS.map((coin) => coin.id),
      args.breakerKeys,
    );
  } catch (error) {
    console.warn("[sync-live-reserves] Ghost reserve artifact cleanup failed:", error);
  }

  await persistLiveReserveCursorState(
    args.db,
    args.deferredCoins,
    args.nextCursorStablecoinId,
  );

  let historyPrune: Awaited<ReturnType<typeof pruneLiveReserveHistory>> | null = null;
  try {
    historyPrune = await pruneLiveReserveHistory(args.db, args.runStartedAt);
  } catch (error) {
    console.warn("[sync-live-reserves] Live reserve history prune failed:", error);
  }

  const status: CronResult["status"] =
    args.synced === 0 && (args.failed > 0 || args.skipped > 0)
      ? "error"
      : (args.failed + args.skipped) > Math.ceil(args.total * 0.1)
        ? "degraded"
        : "ok";

  return {
    itemCount: args.synced,
    status,
    metadata: JSON.stringify({
      structureVersion: 2,
      synced: args.synced,
      failed: args.failed,
      skipped: args.skipped,
      total: args.total,
      warningCount: args.warningMessages.length,
      deferredCoins: args.deferredCoins,
      nextCursorStablecoinId: args.nextCursorStablecoinId,
      ...(args.coinsWithWarnings.length > 0 ? { coinsWithWarnings: args.coinsWithWarnings } : {}),
      ...(args.coinsWithErrors.length > 0 ? { coinsWithErrors: args.coinsWithErrors } : {}),
      ...(args.warningMessages.length > 0 ? { warnings: args.warningMessages } : {}),
      ...(historyPrune ? { historyPrune } : {}),
      breakerKeys: Array.from(args.breakerKeys),
    }),
  };
}

export async function syncLiveReserves(
  db: D1Database,
  signal: AbortSignal,
  adapterCtx?: AdapterContext,
  reportProgress?: CronProgressReporter,
): Promise<CronResult> {
  const runStartedAt = Math.floor(Date.now() / 1000);
  const runStartedMs = Date.now();
  const cursorState = await loadLiveReserveCursorState(db);
  const orderedCoins = rotateConfiguredCoins(CONFIGURED_COINS, cursorState?.nextStablecoinId ?? null);
  const syncStates = await loadReserveSyncStateMap(db, CONFIGURED_COINS.map((coin) => coin.id));
  const effectiveAdapterCtx: AdapterContext = {
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
  });
  const queueResult = await runReserveCoinQueue({
    db,
    signal,
    orderedCoins,
    runStartedMs,
    runAdapter,
    syncStates,
    reportProgress,
  });

  return finalizeReserveSyncRun({
    db,
    total,
    runStartedAt,
    reportProgress,
    ...queueResult,
  });
}
