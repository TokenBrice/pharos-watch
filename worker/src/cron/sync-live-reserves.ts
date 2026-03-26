import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import type { CronProgressReporter, CronResult } from "../lib/cron-logger";
import { getReserveAdapter, type AdapterContext, type AdapterResult, type ReserveAdapterDefinition } from "./reserve-adapters/index";
import { shouldAttemptFetch, recordOutcomeSafe } from "../lib/circuit-breaker";
import { hasDegradingWarnings, hasFatalWarnings, validateAdapterOutput } from "./reserve-adapters/validate";
import { buildInClause } from "../lib/db";
import { reportCronProgress } from "../lib/cron-progress";
import {
  beginReserveSyncAttempt,
  createReserveSyncAttemptId,
  didReserveSyncAttemptFinalizeAsSuccess,
  finalizeReserveSyncAttempt,
  finalizeReserveSyncSuccess,
  getReserveSyncState,
  loadReserveSyncStateMap,
  pruneLiveReserveHistory,
  type ReserveCompositionRecord,
  type ReserveSyncStateRecord,
} from "../lib/live-reserves-store";

const CONFIGURED_COINS = ACTIVE_STABLECOINS.filter((c) => c.liveReservesConfig);
type ConfiguredCoin = (typeof CONFIGURED_COINS)[number];
type LiveReserveConfig = NonNullable<ConfiguredCoin["liveReservesConfig"]>;
type ReserveFailureCategory =
  | "adapter-config"
  | "circuit-open"
  | "network"
  | "upstream-http"
  | "parser-drift"
  | "parse-failure"
  | "validation"
  | "storage-write"
  | "unknown";

function breakerKeyForConfig(config: LiveReserveConfig): string {
  return `live-reserves:${config.breakerScope ?? config.adapter}`;
}

function buildSharedSourceCacheKey(
  config: LiveReserveConfig,
  adapter: ReserveAdapterDefinition,
): string | null {
  if (adapter.sharedSourceMode !== "source-invariant") {
    return null;
  }

  const primary = config.inputs.primary;
  if (primary.kind !== "http-json" && primary.kind !== "http-html") {
    return null;
  }

  return JSON.stringify({
    adapter: config.adapter,
    version: config.version,
    semantics: config.semantics,
    inputs: {
      primary,
      fallbacks: config.inputs.fallbacks ?? null,
    },
    params: config.params ?? null,
  });
}

function buildReserveSyncStateRecord(args: {
  stablecoinId: string;
  config: LiveReserveConfig;
  breakerKey: string;
  previousLastSuccessAt: number | null;
  previousLastSuccessAttemptId?: string | null;
  attemptId: string;
  now: number;
  status: ReserveSyncStateRecord["lastStatus"];
  warnings?: ReserveSyncStateRecord["warnings"];
  lastError?: string | null;
  metadata?: Record<string, unknown>;
  lastSuccessAt?: number | null;
  lastSuccessAttemptId?: string | null;
}): ReserveSyncStateRecord {
  const warnings = args.warnings ?? [];
  return {
    stablecoinId: args.stablecoinId,
    adapterKey: args.config.adapter,
    breakerKey: args.breakerKey,
    lastAttemptedAt: args.now,
    lastSuccessAt: args.lastSuccessAt ?? args.previousLastSuccessAt,
    lastStatus: args.status,
    warningCount: warnings.length,
    warnings,
    lastError: args.lastError ?? null,
    metadata: args.metadata ?? {},
    lastAttemptId: args.attemptId,
    pendingAttemptId: args.attemptId,
    lastSuccessAttemptId: args.lastSuccessAttemptId ?? args.previousLastSuccessAttemptId ?? null,
  };
}

function classifyFailure(reason: string, lastError: string | null): ReserveFailureCategory {
  if (reason === "unknown-adapter") return "adapter-config";
  if (reason === "circuit-open") return "circuit-open";
  if (reason === "storage-write-timeout" || reason === "success-finalize-rejected") return "storage-write";
  if (reason === "validation-failed" || reason === "fatal-warning" || reason === "empty-slices") return "validation";

  const message = (lastError ?? "").toLowerCase();
  if (message.includes("layout-changed")) return "parser-drift";
  if (message.includes("parse-failed") || message.includes("json parse failed")) return "parse-failure";
  if (message.includes("d1 write timeout") || message.includes("sqlite") || message.includes("database")) return "storage-write";
  if (/\bhttp\s+[45]\d{2}\b/.test(message)) return "upstream-http";
  if (
    message.includes("fetch failed")
    || message.includes("no-response")
    || message.includes("adapter-timeout")
    || message.includes("timed out")
    || message.includes("aborted")
    || message.includes("network")
  ) {
    return "network";
  }
  return "unknown";
}

const ADAPTER_TIMEOUT_MS = 20_000;
const D1_WRITE_FINALIZE_TIMEOUT_MS = 30_000;

async function raceWithTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function createAbortableAttemptSignal(
  parentSignal: AbortSignal,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal.reason ?? new Error("sync-live-reserves aborted"));
  if (parentSignal.aborted) {
    abortFromParent();
  } else {
    parentSignal.addEventListener("abort", abortFromParent, { once: true });
  }

  const timer = setTimeout(() => controller.abort(new Error("adapter-timeout")), timeoutMs);
  const cleanup = () => {
    clearTimeout(timer);
    parentSignal.removeEventListener("abort", abortFromParent);
  };

  return { signal: controller.signal, cleanup };
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
    sharedSourceResults.set(cacheKey, resultPromise);
    return resultPromise;
  };

  const runAdapter = async (
    coin: ConfiguredCoin,
    config: LiveReserveConfig,
    adapter: ReserveAdapterDefinition,
  ): Promise<AdapterResult> => {
    try {
      return await tryPrimary(coin, config, adapter);
    } catch (primaryError) {
      for (const fb of config.inputs.fallbacks ?? []) {
        try {
          const fbConfig = { ...config, inputs: { ...config.inputs, primary: fb } };
          return await runAdapterAttempt(coin, fbConfig, adapter, signal, effectiveAdapterCtx);
        } catch { continue; }
      }
      throw primaryError;
    }
  };

  for (const [index, coin] of CONFIGURED_COINS.entries()) {
    if (signal?.aborted) throw signal.reason ?? new Error("sync-live-reserves aborted");
    const config = coin.liveReservesConfig!;
    const adapter = getReserveAdapter(config.adapter);
    const breakerKey = breakerKeyForConfig(config);
    const previousState = syncStates.get(coin.id) ?? null;
    const prevSuccessAt = previousState?.lastSuccessAt ?? null;
    const prevSuccessAttemptId = previousState?.lastSuccessAttemptId ?? null;
    const attemptId = createReserveSyncAttemptId(coin.id);
    const attemptStartedAt = Math.floor(Date.now() / 1000);
    let attemptStarted = false;
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

    const recordFailure = (
      status: ReserveSyncStateRecord["lastStatus"],
      lastError: string | null,
      reason: string,
      warnings: ReserveSyncStateRecord["warnings"] = [],
      metadataExtras?: Record<string, unknown>,
    ) => (
      attemptStarted
        ? finalizeReserveSyncAttempt(db, buildReserveSyncStateRecord({
            stablecoinId: coin.id,
            config,
            breakerKey,
            previousLastSuccessAt: prevSuccessAt,
            previousLastSuccessAttemptId: prevSuccessAttemptId,
            attemptId,
            now: attemptStartedAt,
            status,
            lastError,
            warnings,
            metadata: {
              reason,
              failureCategory: classifyFailure(reason, lastError),
              ...(metadataExtras ?? {}),
            },
          }))
        : Promise.resolve({ finalized: false })
    );

    try {
      await beginReserveSyncAttempt(db, {
        stablecoinId: coin.id,
        adapterKey: config.adapter,
        breakerKey,
        attemptedAt: attemptStartedAt,
        attemptId,
      });
      attemptStarted = true;

      const canFetch = breakerCanFetch.has(breakerKey)
        ? breakerCanFetch.get(breakerKey)!
        : await shouldAttemptFetch(db, breakerKey);
      breakerCanFetch.set(breakerKey, canFetch);
      if (!canFetch) {
        skipped++;
        await recordFailure("skipped", null, "circuit-open");
        continue;
      }

      if (!adapter) {
        console.warn(`[sync-live-reserves] Unknown adapter "${config.adapter}" for ${coin.id}`);
        failed++;
        coinsWithErrors.push(coin.id);
        await recordFailure("error", `Unknown adapter: ${config.adapter}`, "unknown-adapter");
        breakerOutcomes.set(breakerKey, false);
        continue;
      }

      const result = await runAdapter(coin, config, adapter);

      const validation = validateAdapterOutput(result, { adapter, now: attemptStartedAt });
      if (!validation.valid) {
        const msg = validation.warnings.map(w => w.message).join("; ");
        console.warn(`[sync-live-reserves] Adapter output invalid for ${coin.id}: ${msg}`);
        failed++;
        coinsWithErrors.push(coin.id);
        await recordFailure("error", `Validation failed: ${msg}`, "validation-failed", validation.warnings);
        breakerOutcomes.set(breakerKey, false);
        continue;
      }

      if (result.slices.length === 0) {
        console.warn(`[sync-live-reserves] Adapter returned empty slices for ${coin.id}`);
        failed++;
        coinsWithErrors.push(coin.id);
        await recordFailure("error", "Adapter returned zero reserve slices", "empty-slices");
        breakerOutcomes.set(breakerKey, false);
        continue;
      }

      const warnings = [...(result.warnings ?? []), ...validation.warnings];
      if (hasFatalWarnings(warnings)) {
        const msg = warnings
          .filter((warning) => warning.effect === "fatal")
          .map((warning) => warning.message)
          .join("; ");
        failed++;
        coinsWithErrors.push(coin.id);
        await recordFailure("error", msg || "Fatal reserve adapter warning", "fatal-warning", warnings);
        breakerOutcomes.set(breakerKey, false);
        continue;
      }
      if (warnings.length > 0) {
        coinsWithWarnings.push(coin.id);
        warningMessages.push(...warnings.map((warning) => `${coin.id}:${warning.code}`));
      }

      const compositionRecord: ReserveCompositionRecord = {
        stablecoinId: coin.id,
        slices: result.slices,
        fetchedAt: attemptStartedAt,
        source: config.adapter,
        attemptId,
        metadata: result.metadata ?? {},
        warningCount: warnings.length,
        warnings,
        adapterSourceModel: adapter.sourceModel,
        adapterEvidenceClass: adapter.evidenceClass,
      };

      const successState = buildReserveSyncStateRecord({
        stablecoinId: coin.id,
        config,
        breakerKey,
        previousLastSuccessAt: prevSuccessAt,
        previousLastSuccessAttemptId: prevSuccessAttemptId,
        attemptId,
        now: attemptStartedAt,
        status: hasDegradingWarnings(warnings) ? "degraded" : "ok",
        warnings,
        metadata: {
          warningEffects: {
            info: warnings.filter((warning) => warning.effect === "info").length,
            degraded: warnings.filter((warning) => warning.effect === "degraded").length,
            fatal: warnings.filter((warning) => warning.effect === "fatal").length,
          },
        },
        lastSuccessAt: attemptStartedAt,
        lastSuccessAttemptId: attemptId,
      });

      let finalizeSucceeded = false;
      try {
        const finalizeResult = await raceWithTimeout(
          finalizeReserveSyncSuccess(
            db,
            compositionRecord,
            successState,
            Date.now() + D1_WRITE_FINALIZE_TIMEOUT_MS,
          ),
          D1_WRITE_FINALIZE_TIMEOUT_MS,
          `D1 write timeout for ${coin.id}`,
        );
        finalizeSucceeded = finalizeResult.finalized;
      } catch (e) {
        const timeoutMessage = `D1 write timeout for ${coin.id}`;
        if (!(e instanceof Error) || e.message !== timeoutMessage) {
          throw e;
        }

        console.warn(`[sync-live-reserves] ${timeoutMessage}; clearing pending attempt authority`);
        await recordFailure("error", timeoutMessage, "storage-write-timeout", warnings, {
          uncertainWrite: true,
        });
      }

      if (!finalizeSucceeded) {
        const latestState = await getReserveSyncState(db, coin.id).catch(() => null);
        if (!didReserveSyncAttemptFinalizeAsSuccess(latestState, attemptId)) {
          await recordFailure(
            "error",
            `Authoritative live reserve finalize rejected for ${coin.id}`,
            "success-finalize-rejected",
            warnings,
            { uncertainWrite: true },
          );
          failed++;
          coinsWithErrors.push(coin.id);
          breakerOutcomes.set(breakerKey, false);
          continue;
        }
      }

      if (breakerOutcomes.get(breakerKey) !== false) {
        breakerOutcomes.set(breakerKey, true);
      }
      synced++;
    } catch (e) {
      console.error(`[sync-live-reserves] Failed for ${coin.id}:`, e);
      failed++;
      coinsWithErrors.push(coin.id);
      await recordFailure("error", e instanceof Error ? e.message : String(e), "adapter-exception");
      breakerOutcomes.set(breakerKey, false);
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
