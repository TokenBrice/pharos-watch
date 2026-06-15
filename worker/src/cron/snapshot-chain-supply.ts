import { batchExecute } from "../lib/db";
import { CHAIN_META } from "@shared/lib/chains";
import { rethrowIfAborted, throwIfAborted } from "../lib/abort";
import { recordCronFailure, type CronResult } from "../lib/cron-logger";
import { loadStablecoinsCache } from "../lib/stablecoins-cache";
import { getCache, setCache } from "../lib/db-cache";
import { canonicalizeChainCirculating } from "@shared/lib/chain-circulating";
import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import { startOfUtcDaySec } from "../lib/time-constants";

const CACHE_MAX_AGE_SEC = 1200;

export async function snapshotChainSupply(db: D1Database, signal?: AbortSignal): Promise<CronResult> {
  throwIfAborted(signal);

  const cache = await loadStablecoinsCache(db, { mode: "strict", allowLegacyArray: false });
  if (cache.kind !== "ok") {
    console.error("[snapshot-chain-supply] No stablecoins cache found");
    return { status: "degraded", itemCount: 0, metadata: JSON.stringify({ reason: cache.reason }) };
  }

  const cacheAge = Math.floor(Date.now() / 1000) - cache.updatedAt;
  if (cacheAge > CACHE_MAX_AGE_SEC) {
    console.warn(`[snapshot-chain-supply] Cache is ${cacheAge}s old (>${CACHE_MAX_AGE_SEC}s), skipping`);
    return { status: "degraded", itemCount: 0, metadata: JSON.stringify({ reason: "cache_stale", cacheAgeSec: cacheAge }) };
  }

  // One snapshot per UTC day, keyed on the marker's stored snapshotDate.
  // See snapshot-supply.ts for the drift rationale.
  const snapshotDate = startOfUtcDaySec();
  const lastWrite = await getCache(db, "snapshot-chain-supply:last-write");
  if (lastWrite) {
    let lastSnapshotDate: unknown;
    try {
      lastSnapshotDate = (JSON.parse(lastWrite.value) as { snapshotDate?: unknown }).snapshotDate;
    } catch {
      lastSnapshotDate = undefined;
    }
    if (lastSnapshotDate === snapshotDate) {
      return { itemCount: 0, metadata: JSON.stringify({ reason: "already_written_today", snapshotDate }) };
    }
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

  try {
    await batchExecute(db, stmts, { signal });
    await setCache(db, "snapshot-chain-supply:last-write", JSON.stringify({ snapshotDate }));
  } catch (err) {
    rethrowIfAborted(err, signal);
    recordCronFailure("snapshot-chain-supply", err, { metadata: { stage: "batchExecute" } });
    return { status: "degraded", itemCount: 0, metadata: JSON.stringify({ reason: "db_write_failed", error: String(err).slice(0, 200) }) };
  }

  console.log(`[snapshot-chain-supply] Inserted ${stmts.length} rows for ${new Date(snapshotDate * 1000).toISOString().slice(0, 10)}`);
  return { itemCount: stmts.length };
}
