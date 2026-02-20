import { getCache, batchExecute } from "../lib/db";
import { TRACKED_STABLECOINS } from "../../../src/lib/stablecoins";
import { sumPegBuckets } from "../../../src/lib/supply";
import type { CronResult } from "../lib/db";

export async function snapshotSupply(db: D1Database): Promise<CronResult> {
  const cached = await getCache(db, "stablecoins");
  if (!cached) {
    console.error("[snapshot-supply] No stablecoins cache found");
    return { itemCount: 0 };
  }

  // Verify cache freshness — skip if stale (>20 min) to avoid snapshotting outdated data
  const cacheAge = Math.floor(Date.now() / 1000) - cached.updatedAt;
  if (cacheAge > 1200) {
    console.warn(`[snapshot-supply] Cache is ${cacheAge}s old (>1200s), skipping snapshot`);
    return { itemCount: 0 };
  }
  if (cacheAge > 600) {
    console.warn(`[snapshot-supply] Cache is ${cacheAge}s old (>600s), proceeding with degraded freshness`);
  }

  const data = JSON.parse(cached.value) as {
    peggedAssets: { id: string; price?: number | null; circulating?: Record<string, number> }[];
  };
  if (!data.peggedAssets) {
    console.error("[snapshot-supply] No peggedAssets in cache");
    return { itemCount: 0 };
  }

  const trackedIds = new Set(TRACKED_STABLECOINS.map((s) => s.id));

  // Floor to UTC midnight
  const now = new Date();
  const snapshotDate = Math.floor(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000
  );

  const stmts: D1PreparedStatement[] = [];

  for (const asset of data.peggedAssets) {
    if (!trackedIds.has(asset.id)) continue;

    const circ = asset.circulating;
    if (!circ) continue;
    const circulatingUsd = sumPegBuckets(circ);
    if (circulatingUsd <= 0) continue;

    const price = typeof asset.price === "number" && asset.price > 0 ? asset.price : null;

    stmts.push(
      db
        .prepare(
          "INSERT OR IGNORE INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price) VALUES (?, ?, ?, ?)"
        )
        .bind(asset.id, snapshotDate, circulatingUsd, price)
    );
  }

  const expectedCount = trackedIds.size;
  if (stmts.length < expectedCount * 0.8) {
    console.warn(`[snapshot-supply] Only ${stmts.length}/${expectedCount} coins have valid data — possible upstream issue`);
  }

  if (stmts.length > 0) {
    await batchExecute(db, stmts);
  }

  console.log(`[snapshot-supply] Inserted ${stmts.length} rows for date ${new Date(snapshotDate * 1000).toISOString().slice(0, 10)}`);
  return { itemCount: stmts.length };
}
