import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import type { CronProgressReporter, CronResult } from "../lib/cron-logger";
import { getReserveAdapter, type AdapterContext, type AdapterResult, type ReserveAdapterDefinition } from "./reserve-adapters/index";
import { recordOutcomeSafe } from "../lib/circuit-breaker";
import { buildInClause } from "../lib/db";
import { reportCronProgress } from "../lib/cron-progress";
import {
  loadReserveSyncStateMap,
  pruneLiveReserveHistory,
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

const ADAPTER_TIMEOUT_MS = 20_000;

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
    return await adapter.fetch(coin, config, attemptSignal, adapterCtx);
  } finally {
    cleanup();
  }
}

export async function syncLiveReserves(
  db: D1Database,
  signal: AbortSignal,
  adapterCtx?: AdapterContext,
  reportProgress?: CronProgressReporter,
): Promise<CronResult> {
  let synced = 0;
  let failed = 0;
  let skipped = 0;
  const runStartedAt = Math.floor(Date.now() / 1000);
  const warningMessages: string[] = [];
  const coinsWithErrors: string[] = [];
  const coinsWithWarnings: string[] = [];
  const breakerKeys = new Set<string>();
  const sharedSourceResults = new Map<string, Promise<AdapterResult>>();
  const syncStates = await loadReserveSyncStateMap(db, CONFIGURED_COINS.map((coin) => coin.id));
  const breakerOutcomes = new Map<string, boolean>();
  const breakerCanFetch = new Map<string, boolean>();
  const effectiveAdapterCtx: AdapterContext = {
    ...(adapterCtx ?? {}),
    nowSec: runStartedAt,
    requestCache: adapterCtx?.requestCache ?? new Map<string, Promise<unknown>>(),
  };
  const total = CONFIGURED_COINS.length;

  await reportLiveReserveProgress(reportProgress, {
    stage: "setup",
    message: "Loaded live reserve sync state",
    itemsDone: 0,
    itemsTotal: total,
    synced,
    failed,
    skipped,
  });

  const tryPrimary = (
    coin: ConfiguredCoin,
    config: LiveReserveConfig,
    adapter: ReserveAdapterDefinition,
  ): Promise<AdapterResult> => {
    const cacheKey = buildSharedSourceCacheKey(config, adapter);
    if (!cacheKey) {
      return runAdapterAttempt(coin, config, adapter, signal, effectiveAdapterCtx);
    }

    const cached = sharedSourceResults.get(cacheKey);
    if (cached) return cached;

    const resultPromise = runAdapterAttempt(coin, config, adapter, signal, effectiveAdapterCtx);
    const cachedPromise = resultPromise.catch((error) => {
      sharedSourceResults.delete(cacheKey);
      throw error;
    });
    sharedSourceResults.set(cacheKey, cachedPromise);
    return cachedPromise;
  };

  const runAdapter = async (
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
          return await runAdapterAttempt(coin, fbConfig, adapter, signal, effectiveAdapterCtx);
        } catch (e) {
          fallbackAttempts.push({ input: fb, error: e, index: fallbackAttempts.length });
          console.warn(`[sync-live-reserves] Fallback failed for ${coin.id}:`, e);
          continue;
        }
      }
      throw buildReserveAdapterAttemptChainError(config, primaryError, fallbackAttempts);
    }
  };

  for (const [index, coin] of CONFIGURED_COINS.entries()) {
    if (signal?.aborted) throw signal.reason ?? new Error("sync-live-reserves aborted");
    const config = coin.liveReservesConfig!;
    const breakerKey = breakerKeyForConfig(config);
    breakerKeys.add(breakerKey);

    await reportLiveReserveProgress(reportProgress, {
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
      db,
      coin,
      signal,
      adapter: getReserveAdapter(config.adapter),
      runAdapter,
      breakerCanFetch,
      previousState: syncStates.get(coin.id) ?? null,
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

  await reportLiveReserveProgress(reportProgress, {
    stage: "finalizing",
    message: "Recording reserve sync outcomes and cleanup",
    itemsDone: total,
    itemsTotal: total,
    synced,
    failed,
    skipped,
  });

  // Deferred breaker outcome recording: worst outcome per key wins
  for (const [key, success] of breakerOutcomes) {
    await recordOutcomeSafe(db, key, success);
  }

  // Clean up ghost reserve_sync_state rows for coins no longer configured
  if (CONFIGURED_COINS.length > 0) {
    try {
      const idClause = buildInClause(CONFIGURED_COINS.map((c) => c.id));
      await db
        .prepare(`DELETE FROM reserve_sync_state WHERE stablecoin_id NOT IN (${idClause.sql})`)
        .bind(...idClause.binds)
        .run();
    } catch (e) {
      console.warn("[sync-live-reserves] Ghost row cleanup failed:", e);
    }
  }

  let historyPrune: Awaited<ReturnType<typeof pruneLiveReserveHistory>> | null = null;
  try {
    historyPrune = await pruneLiveReserveHistory(db, runStartedAt);
  } catch (e) {
    console.warn("[sync-live-reserves] Live reserve history prune failed:", e);
  }

  const status: CronResult["status"] =
    synced === 0 && (failed > 0 || skipped > 0)
      ? "error"
      : (failed + skipped) > Math.ceil(total * 0.1)
        ? "degraded"
        : "ok";

  return {
    itemCount: synced,
    status,
    metadata: JSON.stringify({
      structureVersion: 2,
      synced,
      failed,
      skipped,
      total,
      warningCount: warningMessages.length,
      ...(coinsWithWarnings.length > 0 ? { coinsWithWarnings } : {}),
      ...(coinsWithErrors.length > 0 ? { coinsWithErrors } : {}),
      ...(warningMessages.length > 0 ? { warnings: warningMessages } : {}),
      ...(historyPrune ? { historyPrune } : {}),
      breakerKeys: Array.from(breakerKeys),
    }),
  };
}
