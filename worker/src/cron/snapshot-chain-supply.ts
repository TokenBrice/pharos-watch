import { batchExecute } from "../lib/db";
import { CHAIN_META } from "@shared/lib/chains";
import type { CronResult } from "../lib/cron-logger";
import { loadStablecoinsCache } from "../lib/stablecoins-cache";
import { getCache, setCache } from "../lib/db-cache";
import { canonicalizeChainCirculating } from "@shared/lib/chain-circulating";
import { ACTIVE_IDS } from "@shared/lib/stablecoins";

export async function snapshotChainSupply(db: D1Database, signal?: AbortSignal): Promise<CronResult> {
  if (signal?.aborted) {
    return { status: "degraded", itemCount: 0, metadata: JSON.stringify({ reason: "aborted" }) };
  }

  const cache = await loadStablecoinsCache(db, { mode: "strict", allowLegacyArray: false });
  if (cache.kind !== "ok") {
    console.error("[snapshot-chain-supply] No stablecoins cache found");
    return { status: "degraded", itemCount: 0, metadata: JSON.stringify({ reason: cache.reason }) };
  }

  const cacheAge = Math.floor(Date.now() / 1000) - cache.updatedAt;
  if (cacheAge > 1200) {
    console.warn(`[snapshot-chain-supply] Cache is ${cacheAge}s old (>1200s), skipping`);
    return { status: "degraded", itemCount: 0, metadata: JSON.stringify({ reason: "cache_stale", cacheAgeSec: cacheAge }) };
  }

  // One snapshot per UTC day. See snapshot-supply.ts for the rationale.
  const COOLDOWN_SEC = 20 * 3600;
  const lastWrite = await getCache(db, "snapshot-chain-supply:last-write");
  if (lastWrite && (Math.floor(Date.now() / 1000) - lastWrite.updatedAt) < COOLDOWN_SEC) {
    return { itemCount: 0, metadata: JSON.stringify({ reason: "cooldown_active", lastWriteAgeSec: Math.floor(Date.now() / 1000) - lastWrite.updatedAt }) };
  }

  // Accumulate per-chain totals
  const chainTotals = new Map<string, { totalUsd: number; coinCount: number }>();

  for (const asset of cache.payload.peggedAssets) {
    if (!ACTIVE_IDS.has(String(asset.id))) continue;
    const canonicalChainCirculating = canonicalizeChainCirculating(asset.chainCirculating);

    for (const [chainId, data] of canonicalChainCirculating) {
      const current = data.current ?? 0;
      if (current <= 0) continue;

      if (!CHAIN_META[chainId]) continue;

      const existing = chainTotals.get(chainId) ?? { totalUsd: 0, coinCount: 0 };
      existing.totalUsd += current;
      existing.coinCount += 1;
      chainTotals.set(chainId, existing);
    }
  }

  // Floor to UTC midnight
  const now = new Date();
  const snapshotDate = Math.floor(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000,
  );

  const stmts: D1PreparedStatement[] = [];
  for (const [chainId, { totalUsd, coinCount }] of chainTotals) {
    stmts.push(
      db.prepare(
        "INSERT OR REPLACE INTO chain_supply_history (chain_id, snapshot_date, total_usd, stablecoin_count) VALUES (?, ?, ?, ?)",
      ).bind(chainId, snapshotDate, totalUsd, coinCount),
    );
  }

  if (stmts.length === 0) {
    console.warn("[snapshot-chain-supply] No valid chain rows produced, preserving previous snapshot");
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({ reason: "no-valid-chain-rows", assetCount: cache.payload.peggedAssets.length }),
    };
  }

  if (stmts.length > 0) {
    try {
      await batchExecute(db, stmts);
      await setCache(db, "snapshot-chain-supply:last-write", JSON.stringify({ snapshotDate }));
    } catch (err) {
      console.error("[snapshot-chain-supply] batchExecute failed:", err);
      return { status: "degraded", itemCount: 0, metadata: JSON.stringify({ reason: "db_write_failed", error: String(err).slice(0, 200) }) };
    }
  }

  console.log(`[snapshot-chain-supply] Inserted ${stmts.length} rows for ${new Date(snapshotDate * 1000).toISOString().slice(0, 10)}`);
  return { itemCount: stmts.length };
}
