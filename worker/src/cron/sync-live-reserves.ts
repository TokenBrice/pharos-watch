import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import type { CronResult } from "../lib/cron-logger";
import { getReserveAdapter, type AdapterContext, type AdapterResult } from "./reserve-adapters/index";
import { shouldAttemptFetch, recordOutcomeSafe } from "../lib/circuit-breaker";
import { validateAdapterOutput } from "./reserve-adapters/validate";
import {
  getReserveSyncState,
  upsertReserveSnapshot,
  upsertReserveSyncState,
  type ReserveSyncStateRecord,
} from "../lib/live-reserves-store";

const CONFIGURED_COINS = TRACKED_STABLECOINS.filter((c) => c.liveReservesConfig);
type ConfiguredCoin = (typeof CONFIGURED_COINS)[number];
type LiveReserveConfig = NonNullable<ConfiguredCoin["liveReservesConfig"]>;

function breakerKeyForConfig(config: LiveReserveConfig): string {
  return `live-reserves:${config.breakerScope ?? config.adapter}`;
}

function buildSharedSourceCacheKey(config: LiveReserveConfig): string | null {
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
  const recordedBreakerOutcomes = new Set<string>();

  const runAdapter = (
    coin: ConfiguredCoin,
    config: LiveReserveConfig,
    adapter: NonNullable<ReturnType<typeof getReserveAdapter>>,
  ): Promise<AdapterResult> => {
    const cacheKey = buildSharedSourceCacheKey(config);
    if (!cacheKey) {
      return adapter(coin, config, signal, adapterCtx);
    }

    const cached = sharedSourceResults.get(cacheKey);
    if (cached) {
      return cached;
    }

    const resultPromise = adapter(coin, config, signal, adapterCtx);
    sharedSourceResults.set(cacheKey, resultPromise);
    return resultPromise;
  };

  for (const coin of CONFIGURED_COINS) {
    const config = coin.liveReservesConfig!;
    const adapter = getReserveAdapter(config.adapter);
    const breakerKey = breakerKeyForConfig(config);
    const previousState = await getReserveSyncState(db, coin.id);
    breakerKeys.add(breakerKey);

    const canFetch = await shouldAttemptFetch(db, breakerKey);
    if (!canFetch) {
      skipped++;
      await upsertReserveSyncState(db, buildReserveSyncStateRecord({
        stablecoinId: coin.id,
        config,
        breakerKey,
        previousLastSuccessAt: previousState?.lastSuccessAt ?? null,
        now,
        status: "skipped",
        metadata: { reason: "circuit-open" },
      }));
      continue;
    }

    if (!adapter) {
      console.warn(`[sync-live-reserves] Unknown adapter "${config.adapter}" for ${coin.id}`);
      failed++;
      coinsWithErrors.push(coin.id);
      await upsertReserveSyncState(db, buildReserveSyncStateRecord({
        stablecoinId: coin.id,
        config,
        breakerKey,
        previousLastSuccessAt: previousState?.lastSuccessAt ?? null,
        now,
        status: "error",
        lastError: `Unknown adapter: ${config.adapter}`,
        metadata: { reason: "unknown-adapter" },
      }));
      if (!recordedBreakerOutcomes.has(breakerKey)) {
        await recordOutcomeSafe(db, breakerKey, false);
        recordedBreakerOutcomes.add(breakerKey);
      }
      continue;
    }

    try {
      const result = await runAdapter(coin, config, adapter);

      const validation = validateAdapterOutput(result);
      if (!validation.valid) {
        console.warn(`[sync-live-reserves] Adapter output invalid for ${coin.id}: ${validation.warnings.map(w => w.message).join("; ")}`);
        failed++;
        coinsWithErrors.push(coin.id);
        await upsertReserveSyncState(db, buildReserveSyncStateRecord({
          stablecoinId: coin.id,
          config,
          breakerKey,
          previousLastSuccessAt: previousState?.lastSuccessAt ?? null,
          now,
          status: "error",
          lastError: `Validation failed: ${validation.warnings.map(w => w.message).join("; ")}`,
          metadata: { reason: "validation-failed" },
        }));
        if (!recordedBreakerOutcomes.has(breakerKey)) {
          await recordOutcomeSafe(db, breakerKey, false);
          recordedBreakerOutcomes.add(breakerKey);
        }
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
        await upsertReserveSyncState(db, buildReserveSyncStateRecord({
          stablecoinId: coin.id,
          config,
          breakerKey,
          previousLastSuccessAt: previousState?.lastSuccessAt ?? null,
          now,
          status: "error",
          lastError: "Adapter returned zero reserve slices",
          metadata: { reason: "empty-slices" },
        }));
        if (!recordedBreakerOutcomes.has(breakerKey)) {
          await recordOutcomeSafe(db, breakerKey, false);
          recordedBreakerOutcomes.add(breakerKey);
        }
        continue;
      }

      const warnings = result.warnings ?? [];
      if (warnings.length > 0) {
        coinsWithWarnings.push(coin.id);
        warningMessages.push(...warnings.map((warning) => `${coin.id}:${warning.code}`));
      }

      await upsertReserveSnapshot(
        db,
        {
          stablecoinId: coin.id,
          slices: result.slices,
          fetchedAt: now,
          source: config.adapter,
        },
        buildReserveSyncStateRecord({
          stablecoinId: coin.id,
          config,
          breakerKey,
          previousLastSuccessAt: previousState?.lastSuccessAt ?? null,
          now,
          status: warnings.length > 0 ? "degraded" : "ok",
          warnings,
          metadata: result.metadata ?? {},
          lastSuccessAt: now,
        }),
      );
      if (!recordedBreakerOutcomes.has(breakerKey)) {
        await recordOutcomeSafe(db, breakerKey, true);
        recordedBreakerOutcomes.add(breakerKey);
      }
      synced++;
    } catch (e) {
      console.error(`[sync-live-reserves] Failed for ${coin.id}:`, e);
      failed++;
      coinsWithErrors.push(coin.id);
      await upsertReserveSyncState(db, buildReserveSyncStateRecord({
        stablecoinId: coin.id,
        config,
        breakerKey,
        previousLastSuccessAt: previousState?.lastSuccessAt ?? null,
        now,
        status: "error",
        lastError: e instanceof Error ? e.message : String(e),
        metadata: { reason: "adapter-exception" },
      }));
      if (!recordedBreakerOutcomes.has(breakerKey)) {
        await recordOutcomeSafe(db, breakerKey, false);
        recordedBreakerOutcomes.add(breakerKey);
      }
    }
  }

  const total = CONFIGURED_COINS.length;
  const hasWarnings = warningMessages.length > 0;
  const status: CronResult["status"] =
    synced === 0 && (failed > 0 || skipped > 0)
      ? "error"
      : failed > 0 || skipped > 0 || hasWarnings
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
