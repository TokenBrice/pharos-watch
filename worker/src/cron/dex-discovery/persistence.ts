import { batchExecute } from "../../lib/db";
import type { DiscoveryMeta, StagedPool } from "./types";

const STAGING_UPSERT_SQL = `INSERT INTO dex_pool_staging
  (pool_id, stablecoin_id, source, chain, protocol, dex_id, symbol, tvl_usd, volume_24h, quality_multiplier, pool_type, fee_tier, balance_ratio,
   is_stable, base_token, quote_token, quote_symbol, price_usd, locked_liq_pct, raw_json, discovered_at, refreshed_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(pool_id, stablecoin_id) DO UPDATE SET
  source = excluded.source,
  chain = excluded.chain,
  protocol = excluded.protocol,
  dex_id = excluded.dex_id,
  symbol = excluded.symbol,
  tvl_usd = excluded.tvl_usd,
  volume_24h = excluded.volume_24h,
  quality_multiplier = excluded.quality_multiplier,
  pool_type = excluded.pool_type,
  fee_tier = excluded.fee_tier,
  balance_ratio = excluded.balance_ratio,
  is_stable = excluded.is_stable,
  base_token = excluded.base_token,
  quote_token = excluded.quote_token,
  quote_symbol = excluded.quote_symbol,
  price_usd = excluded.price_usd,
  locked_liq_pct = excluded.locked_liq_pct,
  raw_json = excluded.raw_json,
  refreshed_at = excluded.refreshed_at`;

const STAGING_BATCH_SIZE = 50;
const STAGING_DELETE_TTL_SEC = 172800; // 48h
const STAGING_RAW_JSON_TTL_SEC = 21600; // 6h
const RUN_SEQ_KEY = "discovery_run_seq";

// Canonical pool_id shapes observed in dex_pool_staging:
//   "chain:0xhex"                 (EVM, lowercased)
//   "chain:base58MixedCase"       (Solana et al)
//   "orderbook:exchangeId:coinId" (synthetic CG-tickers rows)
// Left side (chain slug) is lowercase. Right side tolerates mixed case for
// base58 addresses and the extra coin segment for orderbook rows.
const POOL_ID_REGEX = /^[a-z0-9-]+:[A-Za-z0-9][A-Za-z0-9:_.-]*$/;

export function isValidStagedPoolId(poolId: string): boolean {
  return POOL_ID_REGEX.test(poolId);
}

/**
 * Upsert discovered pools into dex_pool_staging.
 * Preserves initial discovery timestamp on re-discovery by updating conflicting rows in place.
 * Batches in groups of 50 to stay within D1 statement limits.
 */
export async function upsertStagedPools(db: D1Database, pools: StagedPool[]): Promise<void> {
  if (pools.length === 0) return;

  const validPools = pools.filter((pool) => {
    if (isValidStagedPoolId(pool.poolId)) return true;
    console.warn(
      `[dex-discovery] rejected malformed pool_id: ${JSON.stringify(pool.poolId)} (stablecoin=${pool.stablecoinId})`,
    );
    return false;
  });
  if (validPools.length === 0) return;

  const stmts = validPools.map((pool) =>
    db
      .prepare(STAGING_UPSERT_SQL)
      .bind(
        pool.poolId,
        pool.stablecoinId,
        pool.source,
        pool.chain,
        pool.protocol,
        pool.dexId,
        pool.symbol,
        pool.tvlUsd,
        pool.volume24h,
        pool.qualityMultiplier,
        pool.poolType,
        pool.feeTier,
        pool.balanceRatio,
        pool.isStable === null ? null : pool.isStable ? 1 : 0,
        pool.baseToken,
        pool.quoteToken,
        pool.quoteSymbol,
        pool.priceUsd,
        pool.lockedLiqPct,
        pool.rawJson,
        pool.discoveredAt,
        pool.refreshedAt,
      ),
  );

  await batchExecute(db, stmts, STAGING_BATCH_SIZE);
}

/**
 * Update dex_discovery_meta after crawling a coin.
 * Resets consecutive_misses to 0 if poolsFound > 0.
 * Increments consecutive_misses if poolsFound === 0.
 */
export async function updateDiscoveryMeta(
  db: D1Database,
  stablecoinId: string,
  poolsFound: number,
  nowSec: number,
): Promise<void> {
  if (poolsFound > 0) {
    await db
      .prepare(
        `INSERT INTO dex_discovery_meta (stablecoin_id, consecutive_misses, last_crawl_at, last_hit_at)
         VALUES (?, 0, ?, ?)
         ON CONFLICT(stablecoin_id) DO UPDATE SET
           consecutive_misses = 0,
           last_crawl_at = excluded.last_crawl_at,
           last_hit_at = excluded.last_hit_at`,
      )
      .bind(stablecoinId, nowSec, nowSec)
      .run();
    return;
  }

  const result = await db
    .prepare(
      "UPDATE dex_discovery_meta SET consecutive_misses = consecutive_misses + 1, last_crawl_at = ? WHERE stablecoin_id = ?",
    )
    .bind(nowSec, stablecoinId)
    .run();

  if ((result.meta.changes ?? 0) === 0) {
    await db
      .prepare(
        "INSERT INTO dex_discovery_meta (stablecoin_id, consecutive_misses, last_crawl_at, last_hit_at) VALUES (?, 1, ?, NULL)",
      )
      .bind(stablecoinId, nowSec)
      .run();
  }
}

/**
 * Cleanup stale staging data.
 * - Delete rows where refreshed_at < nowSec - 48h (172800)
 * - NULL out raw_json where refreshed_at < nowSec - 6h (21600) to save storage
 */
export async function cleanupStaging(db: D1Database, nowSec: number): Promise<void> {
  await db.batch([
    db
      .prepare("DELETE FROM dex_pool_staging WHERE refreshed_at < ?")
      .bind(nowSec - STAGING_DELETE_TTL_SEC),
    db
      .prepare("UPDATE dex_pool_staging SET raw_json = NULL WHERE raw_json IS NOT NULL AND refreshed_at < ?")
      .bind(nowSec - STAGING_RAW_JSON_TTL_SEC),
  ]);
}

/**
 * Read current discovery meta for all stablecoins.
 */
export async function readDiscoveryMeta(db: D1Database): Promise<Map<string, DiscoveryMeta>> {
  const rows = await db
    .prepare("SELECT stablecoin_id, consecutive_misses, last_crawl_at, last_hit_at FROM dex_discovery_meta")
    .all<{
      stablecoin_id: string;
      consecutive_misses: number;
      last_crawl_at: number;
      last_hit_at: number | null;
    }>();

  const metaById = new Map<string, DiscoveryMeta>();
  for (const row of rows.results ?? []) {
    metaById.set(row.stablecoin_id, {
      stablecoinId: row.stablecoin_id,
      consecutiveMisses: row.consecutive_misses,
      lastCrawlAt: row.last_crawl_at,
      lastHitAt: row.last_hit_at,
    });
  }

  return metaById;
}

/**
 * Read and increment discovery_run_seq from kv_config table.
 * Creates the row if it does not exist (starting at 1).
 * Returns the new sequence number.
 */
export async function incrementRunSeq(db: D1Database): Promise<number> {
  const [, readResult] = await db.batch([
    db
      .prepare(
        `INSERT INTO kv_config (key, value)
         VALUES (?, '1')
         ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(kv_config.value AS INTEGER) + 1 AS TEXT)`,
      )
      .bind(RUN_SEQ_KEY),
    db
      .prepare("SELECT value FROM kv_config WHERE key = ?")
      .bind(RUN_SEQ_KEY),
  ]);

  const value = (readResult.results?.[0] as { value?: string } | undefined)?.value;
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid kv_config value for ${RUN_SEQ_KEY}: ${String(value)}`);
  }
  return parsed;
}
