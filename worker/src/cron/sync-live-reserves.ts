import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import type { CronResult } from "../lib/db";
import { getReserveAdapter, type AdapterContext } from "./reserve-adapters/index";
import { shouldAttemptFetch, recordOutcomeSafe } from "../lib/circuit-breaker";
import { getReserveSyncState, upsertReserveComposition, upsertReserveSyncState } from "../lib/live-reserves-store";

const CONFIGURED_COINS = TRACKED_STABLECOINS.filter((c) => c.liveReservesConfig);

function breakerKeyForConfig(config: NonNullable<(typeof CONFIGURED_COINS)[number]["liveReservesConfig"]>): string {
  return `live-reserves:${config.breakerScope ?? config.adapter}`;
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

  for (const coin of CONFIGURED_COINS) {
    const config = coin.liveReservesConfig!;
    const adapter = getReserveAdapter(config.adapter);
    const breakerKey = breakerKeyForConfig(config);
    const previousState = await getReserveSyncState(db, coin.id);
    breakerKeys.add(breakerKey);

    const canFetch = await shouldAttemptFetch(db, breakerKey);
    if (!canFetch) {
      skipped++;
      await upsertReserveSyncState(db, {
        stablecoinId: coin.id,
        adapterKey: config.adapter,
        breakerKey,
        lastAttemptedAt: now,
        lastSuccessAt: previousState?.lastSuccessAt ?? null,
        lastStatus: "skipped",
        warningCount: 0,
        warnings: [],
        lastError: null,
        metadata: { reason: "circuit-open" },
      });
      continue;
    }

    if (!adapter) {
      console.warn(`[sync-live-reserves] Unknown adapter "${config.adapter}" for ${coin.id}`);
      failed++;
      coinsWithErrors.push(coin.id);
      await upsertReserveSyncState(db, {
        stablecoinId: coin.id,
        adapterKey: config.adapter,
        breakerKey,
        lastAttemptedAt: now,
        lastSuccessAt: previousState?.lastSuccessAt ?? null,
        lastStatus: "error",
        warningCount: 0,
        warnings: [],
        lastError: `Unknown adapter: ${config.adapter}`,
        metadata: { reason: "unknown-adapter" },
      });
      await recordOutcomeSafe(db, breakerKey, false);
      continue;
    }

    try {
      const result = await adapter(coin, config, signal, adapterCtx);
      if (result.slices.length === 0) {
        console.warn(`[sync-live-reserves] Adapter returned empty slices for ${coin.id}`);
        failed++;
        coinsWithErrors.push(coin.id);
        await upsertReserveSyncState(db, {
          stablecoinId: coin.id,
          adapterKey: config.adapter,
          breakerKey,
          lastAttemptedAt: now,
          lastSuccessAt: previousState?.lastSuccessAt ?? null,
          lastStatus: "error",
          warningCount: 0,
          warnings: [],
          lastError: "Adapter returned zero reserve slices",
          metadata: { reason: "empty-slices" },
        });
        await recordOutcomeSafe(db, breakerKey, false);
        continue;
      }

      const warnings = result.warnings ?? [];
      if (warnings.length > 0) {
        coinsWithWarnings.push(coin.id);
        warningMessages.push(...warnings.map((warning) => `${coin.id}:${warning.code}`));
      }

      await upsertReserveComposition(db, {
        stablecoinId: coin.id,
        slices: result.slices,
        fetchedAt: now,
        source: config.adapter,
      });
      await upsertReserveSyncState(db, {
        stablecoinId: coin.id,
        adapterKey: config.adapter,
        breakerKey,
        lastAttemptedAt: now,
        lastSuccessAt: now,
        lastStatus: warnings.length > 0 ? "degraded" : "ok",
        warningCount: warnings.length,
        warnings,
        lastError: null,
        metadata: result.metadata ?? {},
      });
      await recordOutcomeSafe(db, breakerKey, true);
      synced++;
    } catch (e) {
      console.error(`[sync-live-reserves] Failed for ${coin.id}:`, e);
      failed++;
      coinsWithErrors.push(coin.id);
      await upsertReserveSyncState(db, {
        stablecoinId: coin.id,
        adapterKey: config.adapter,
        breakerKey,
        lastAttemptedAt: now,
        lastSuccessAt: previousState?.lastSuccessAt ?? null,
        lastStatus: "error",
        warningCount: 0,
        warnings: [],
        lastError: e instanceof Error ? e.message : String(e),
        metadata: { reason: "adapter-exception" },
      });
      await recordOutcomeSafe(db, breakerKey, false);
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
