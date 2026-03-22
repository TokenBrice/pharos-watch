import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import type { LiveReserveAdapterKey } from "@shared/lib/live-reserve-adapters";
import type { CronResult } from "../lib/cron-logger";
import { getReserveAdapter, type AdapterContext, type AdapterResult, type ReserveAdapterDefinition } from "./reserve-adapters/index";
import { shouldAttemptFetch, recordOutcomeSafe } from "../lib/circuit-breaker";
import { validateAdapterOutput } from "./reserve-adapters/validate";
import { buildInClause } from "../lib/db";
import {
  loadReserveSyncStateMap,
  upsertReserveSnapshot,
  upsertReserveSyncState,
  type ReserveSyncStateRecord,
} from "../lib/live-reserves-store";

const CONFIGURED_COINS = ACTIVE_STABLECOINS.filter((c) => c.liveReservesConfig);
type ConfiguredCoin = (typeof CONFIGURED_COINS)[number];
type LiveReserveConfig = NonNullable<ConfiguredCoin["liveReservesConfig"]>;

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
  now: number;
  status: ReserveSyncStateRecord["lastStatus"];
  warnings?: ReserveSyncStateRecord["warnings"];
  lastError?: string | null;
  metadata?: Record<string, unknown>;
  lastSuccessAt?: number | null;
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
  };
}

const ADAPTER_TIMEOUT_MS = 20_000;

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
): Promise<CronResult> {
  let synced = 0;
  let failed = 0;
  let skipped = 0;
  const now = Math.floor(Date.now() / 1000);
  const warningMessages: string[] = [];
  const coinsWithErrors: string[] = [];
  const coinsWithWarnings: string[] = [];
  const breakerKeys = new Set<string>();
  const sharedSourceResults = new Map<string, Promise<AdapterResult>>();
  const syncStates = await loadReserveSyncStateMap(db, CONFIGURED_COINS.map((coin) => coin.id));
  const breakerOutcomes = new Map<string, boolean>();
  const breakerCanFetch = new Map<string, boolean>();

  const tryPrimary = (
    coin: ConfiguredCoin,
    config: LiveReserveConfig,
    adapter: ReserveAdapterDefinition,
  ): Promise<AdapterResult> => {
    const cacheKey = buildSharedSourceCacheKey(config, adapter);
    if (!cacheKey) {
      return runAdapterAttempt(coin, config, adapter, signal, adapterCtx);
    }

    const cached = sharedSourceResults.get(cacheKey);
    if (cached) return cached;

    const resultPromise = runAdapterAttempt(coin, config, adapter, signal, adapterCtx);
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
          return await runAdapterAttempt(coin, fbConfig, adapter, signal, adapterCtx);
        } catch { continue; }
      }
      throw primaryError;
    }
  };

  for (const coin of CONFIGURED_COINS) {
    if (signal?.aborted) throw signal.reason ?? new Error("sync-live-reserves aborted");
    const config = coin.liveReservesConfig!;
    const adapter = getReserveAdapter(config.adapter);
    const breakerKey = breakerKeyForConfig(config);
    const previousState = syncStates.get(coin.id) ?? null;
    const prevSuccessAt = previousState?.lastSuccessAt ?? null;
    breakerKeys.add(breakerKey);

    const recordFailure = (
      status: ReserveSyncStateRecord["lastStatus"],
      lastError: string | null,
      reason: string,
    ) => upsertReserveSyncState(db, buildReserveSyncStateRecord({
      stablecoinId: coin.id, config, breakerKey,
      previousLastSuccessAt: prevSuccessAt, now, status, lastError,
      metadata: { reason },
    }));

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

    try {
      const result = await runAdapter(coin, config, adapter);

      const validation = validateAdapterOutput(result, { feedClass: adapter.feedClass });
      if (!validation.valid) {
        const msg = validation.warnings.map(w => w.message).join("; ");
        console.warn(`[sync-live-reserves] Adapter output invalid for ${coin.id}: ${msg}`);
        failed++;
        coinsWithErrors.push(coin.id);
        await recordFailure("error", `Validation failed: ${msg}`, "validation-failed");
        breakerOutcomes.set(breakerKey, false);
        continue;
      }

      // Propagate sum-deviation warnings to result warnings
      if (validation.warnings.length > 0) {
        result.warnings = [...(result.warnings ?? []), ...validation.warnings];
      }

      if (result.slices.length === 0) {
        console.warn(`[sync-live-reserves] Adapter returned empty slices for ${coin.id}`);
        failed++;
        coinsWithErrors.push(coin.id);
        await recordFailure("error", "Adapter returned zero reserve slices", "empty-slices");
        breakerOutcomes.set(breakerKey, false);
        continue;
      }

      const warnings = result.warnings ?? [];
      if (warnings.length > 0) {
        coinsWithWarnings.push(coin.id);
        warningMessages.push(...warnings.map((warning) => `${coin.id}:${warning.code}`));
      }

      // D1 write with 30s timeout to prevent hanging cron on slow DB
      let dbTimer: ReturnType<typeof setTimeout>;
      await Promise.race([
        upsertReserveSnapshot(
          db,
          {
            stablecoinId: coin.id,
            slices: result.slices,
            fetchedAt: now,
            source: config.adapter,
          },
          buildReserveSyncStateRecord({
            stablecoinId: coin.id, config, breakerKey,
            previousLastSuccessAt: prevSuccessAt, now,
            status: warnings.length > 0 ? "degraded" : "ok",
            warnings,
            metadata: {
              ...(result.metadata ?? {}),
              adapterFeedClass: adapter.feedClass,
              adapterKey: adapter.key as LiveReserveAdapterKey,
            },
            lastSuccessAt: now,
          }),
        ).finally(() => clearTimeout(dbTimer)),
        new Promise<never>((_, reject) => {
          dbTimer = setTimeout(() => reject(new Error(`D1 write timeout for ${coin.id}`)), 30_000);
        }),
      ]);
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

  const total = CONFIGURED_COINS.length;
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
      breakerKeys: Array.from(breakerKeys),
    }),
  };
}
