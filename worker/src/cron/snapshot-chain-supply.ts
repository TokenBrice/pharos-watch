import { batchExecute } from "../lib/db";
import { CHAIN_META, CHAIN_ALIASES } from "@shared/lib/chains";
import type { CronResult } from "../lib/cron-logger";
import { loadStablecoinsCache } from "../lib/stablecoins-cache";

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

  // Accumulate per-chain totals
  const chainTotals = new Map<string, { totalUsd: number; coinCount: number }>();

  for (const asset of cache.payload.peggedAssets) {
    const cc = asset.chainCirculating;
    if (!cc || typeof cc !== "object") continue;

    for (const [rawId, data] of Object.entries(cc)) {
      if (!data || typeof data !== "object") continue;
      const current = (data as { current?: number }).current ?? 0;
      if (current <= 0) continue;

      const canonicalId = CHAIN_ALIASES[rawId] ?? rawId;
      if (!CHAIN_META[canonicalId]) continue;

      const existing = chainTotals.get(canonicalId) ?? { totalUsd: 0, coinCount: 0 };
      existing.totalUsd += current;
      existing.coinCount += 1;
      chainTotals.set(canonicalId, existing);
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

  if (stmts.length > 0) {
    await batchExecute(db, stmts);
  }

  console.log(`[snapshot-chain-supply] Inserted ${stmts.length} rows for ${new Date(snapshotDate * 1000).toISOString().slice(0, 10)}`);
  return { itemCount: stmts.length };
}
