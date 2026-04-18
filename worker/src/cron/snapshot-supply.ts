import { batchExecute } from "../lib/db";
import { PSI_ELIGIBLE_STABLECOINS } from "@shared/lib/psi-eligible";
import { sumPegBuckets } from "@shared/lib/supply";
import type { CronResult } from "../lib/cron-logger";
import { loadStablecoinsCache } from "../lib/stablecoins-cache";
import { getCache, setCache } from "../lib/db-cache";

export async function snapshotSupply(db: D1Database, _signal?: AbortSignal): Promise<CronResult> {
  if (_signal?.aborted) {
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({ reason: "aborted" }),
    };
  }

  const stablecoinsCache = await loadStablecoinsCache(db, { mode: "strict", allowLegacyArray: false });
  if (stablecoinsCache.kind !== "ok") {
    console.error("[snapshot-supply] No stablecoins cache found");
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({ reason: stablecoinsCache.reason }),
    };
  }

  // Verify cache freshness — skip if stale (>20 min) to avoid snapshotting outdated data
  const cacheAge = Math.floor(Date.now() / 1000) - stablecoinsCache.updatedAt;
  if (cacheAge > 1200) {
    console.warn(`[snapshot-supply] Cache is ${cacheAge}s old (>1200s), skipping snapshot`);
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({ reason: "cache_stale", cacheAgeSec: cacheAge }),
    };
  }
  if (cacheAge > 600) {
    console.warn(`[snapshot-supply] Cache is ${cacheAge}s old (>600s), proceeding with degraded freshness`);
  }

  // One snapshot per UTC day. Use 20h (not 24h) so we tolerate daylight/leap-second
  // drift without skipping a day. The cron fires every 15 min on the quarter-hourly
  // lane; 23 of 24 previous runs within a day would otherwise overwrite the same
  // INSERT OR REPLACE row keyed on snapshot_date.
  const COOLDOWN_SEC = 20 * 3600;
  const lastWrite = await getCache(db, "snapshot-supply:last-write");
  if (lastWrite && (Math.floor(Date.now() / 1000) - lastWrite.updatedAt) < COOLDOWN_SEC) {
    return { itemCount: 0, metadata: JSON.stringify({ reason: "cooldown_active", lastWriteAgeSec: Math.floor(Date.now() / 1000) - lastWrite.updatedAt }) };
  }

  const trackedIds = new Set(PSI_ELIGIBLE_STABLECOINS.map((s) => s.id));

  // Floor to UTC midnight
  const now = new Date();
  const snapshotDate = Math.floor(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000
  );

  const stmts: D1PreparedStatement[] = [];

  for (const asset of stablecoinsCache.payload.peggedAssets) {
    if (!trackedIds.has(asset.id)) continue;

    const circ = asset.circulating;
    if (!circ) continue;
    const circulatingUsd = sumPegBuckets(circ);
    if (circulatingUsd <= 0) continue;

    const price = typeof asset.price === "number" && asset.price > 0 ? asset.price : null;

    stmts.push(
      db
        .prepare(
          "INSERT OR REPLACE INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price) VALUES (?, ?, ?, ?)"
        )
        .bind(asset.id, snapshotDate, circulatingUsd, price)
    );
  }

  const expectedCount = trackedIds.size;
  if (stmts.length < expectedCount * 0.8) {
    console.warn(`[snapshot-supply] Only ${stmts.length}/${expectedCount} coins have valid data — possible upstream issue`);
  }

  if (stmts.length > 0) {
    try {
      await batchExecute(db, stmts);
      await setCache(db, "snapshot-supply:last-write", JSON.stringify({ snapshotDate }));
    } catch (err) {
      console.error("[snapshot-supply] batchExecute failed:", err);
      return { status: "degraded", itemCount: 0, metadata: JSON.stringify({ reason: "db_write_failed", error: String(err).slice(0, 200) }) };
    }
  }

  if (stmts.length === 0) {
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({ reason: "all_coins_zero_supply" }),
    };
  }

  console.log(`[snapshot-supply] Inserted ${stmts.length} rows for date ${new Date(snapshotDate * 1000).toISOString().slice(0, 10)}`);
  return { itemCount: stmts.length };
}
