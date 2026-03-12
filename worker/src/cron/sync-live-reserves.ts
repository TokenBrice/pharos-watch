import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import type { CronResult } from "../lib/db";
import { batchExecute } from "../lib/db";
import { getReserveAdapter, type AdapterContext } from "./reserve-adapters/index";
import { shouldAttemptFetch, recordOutcomeSafe } from "../lib/circuit-breaker";
import { CIRCUIT_SOURCE } from "../lib/constants";

const CONFIGURED_COINS = TRACKED_STABLECOINS.filter((c) => c.liveReservesConfig);

export async function syncLiveReserves(
  db: D1Database,
  signal: AbortSignal,
  adapterCtx?: AdapterContext,
): Promise<CronResult> {
  let synced = 0;
  let failed = 0;
  const now = Math.floor(Date.now() / 1000);
  const allUnknownFarms: string[] = [];

  // Circuit breaker check — one breaker for all live-reserves sources
  const canFetch = await shouldAttemptFetch(db, CIRCUIT_SOURCE.LIVE_RESERVES);
  if (!canFetch) {
    return {
      itemCount: 0,
      metadata: JSON.stringify({ synced: 0, failed: 0, total: CONFIGURED_COINS.length, circuitOpen: true }),
    };
  }

  const upserts: D1PreparedStatement[] = [];

  for (const coin of CONFIGURED_COINS) {
    const config = coin.liveReservesConfig!;
    const adapter = getReserveAdapter(config.adapter);
    if (!adapter) {
      console.warn(`[sync-live-reserves] Unknown adapter "${config.adapter}" for ${coin.id}`);
      failed++;
      continue;
    }

    try {
      const result = await adapter(config.url, signal, adapterCtx);
      if (result.slices.length === 0) {
        console.warn(`[sync-live-reserves] Adapter returned empty slices for ${coin.id}`);
        failed++;
        continue;
      }
      if (result.unknownFarms && result.unknownFarms.length > 0) {
        console.warn(`[sync-live-reserves] Unknown farms for ${coin.id}: ${result.unknownFarms.join(", ")}`);
        allUnknownFarms.push(...result.unknownFarms);
      }
      upserts.push(
        db
          .prepare(
            `INSERT INTO reserve_composition (stablecoin_id, slices, fetched_at, source)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(stablecoin_id) DO UPDATE SET
               slices = excluded.slices,
               fetched_at = excluded.fetched_at,
               source = excluded.source`,
          )
          .bind(coin.id, JSON.stringify(result.slices), now, config.adapter),
      );
      synced++;
    } catch (e) {
      console.error(`[sync-live-reserves] Failed for ${coin.id}:`, e);
      failed++;
    }
  }

  // Record circuit breaker outcome
  await recordOutcomeSafe(db, CIRCUIT_SOURCE.LIVE_RESERVES, failed < CONFIGURED_COINS.length);

  if (upserts.length > 0) {
    await batchExecute(db, upserts);
  }

  return {
    itemCount: synced,
    metadata: JSON.stringify({
      synced,
      failed,
      total: CONFIGURED_COINS.length,
      ...(allUnknownFarms.length > 0 ? { unknownFarms: allUnknownFarms } : {}),
    }),
  };
}
