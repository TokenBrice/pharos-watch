import { batchExecute } from "../../lib/db";
import { throwIfAborted } from "../../lib/abort";
import { runWithOverloadRetry } from "../../lib/cron-lease";
import { STAGED_POOL_MAX_TVL_USD, type DiscoveryMeta, type StagedPool } from "./types";

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
const ORDERBOOK_POOL_ID_PREFIX = "orderbook:";

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

export function hasValidStagedPoolTvl(pool: Pick<StagedPool, "tvlUsd">): boolean {
  return (
    pool.tvlUsd == null ||
    (Number.isFinite(pool.tvlUsd) && pool.tvlUsd >= 0 && pool.tvlUsd <= STAGED_POOL_MAX_TVL_USD)
  );
}

function legacyOrderbookPoolId(pool: Pick<StagedPool, "poolId" | "stablecoinId" | "source">): string | null {
  if (pool.source !== "cg_tickers") return null;
  if (!pool.poolId.startsWith(ORDERBOOK_POOL_ID_PREFIX)) return null;
  const suffix = pool.poolId.slice(ORDERBOOK_POOL_ID_PREFIX.length);
  const stablecoinSuffix = `:${pool.stablecoinId.toLowerCase()}`;
  if (!suffix.toLowerCase().endsWith(stablecoinSuffix)) return null;
  const exchangeId = suffix.slice(0, suffix.length - stablecoinSuffix.length);
  if (!exchangeId || exchangeId.includes(":")) return null;
  return `${ORDERBOOK_POOL_ID_PREFIX}${exchangeId.toLowerCase()}`;
}

/**
 * Upsert discovered pools into dex_pool_staging.
 * Preserves initial discovery timestamp on re-discovery by updating conflicting rows in place.
 * Batches in groups of 50 to stay within D1 statement limits.
 */
export async function upsertStagedPools(db: D1Database, pools: StagedPool[], signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (pools.length === 0) return;

  const validPools = pools.filter((pool) => {
    if (!isValidStagedPoolId(pool.poolId)) {
      console.warn(
        `[dex-discovery] rejected malformed pool_id: ${JSON.stringify(pool.poolId)} (stablecoin=${pool.stablecoinId})`,
      );
      return false;
    }
    if (!hasValidStagedPoolTvl(pool)) {
      console.warn(
        `[dex-discovery] rejected staged pool with invalid tvl_usd=${String(pool.tvlUsd)} (pool=${pool.poolId}, stablecoin=${pool.stablecoinId})`,
      );
      return false;
    }
    return true;
  });
  if (validPools.length === 0) return;

  const stmts = validPools.flatMap((pool) => {
    const cleanupPoolId = legacyOrderbookPoolId(pool);
    const cleanupStmt = cleanupPoolId
      ? db
          .prepare("DELETE FROM dex_pool_staging WHERE stablecoin_id = ? AND source = 'cg_tickers' AND pool_id = ?")
          .bind(pool.stablecoinId, cleanupPoolId)
      : null;
    const insertStmt = db
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
      );
    return cleanupStmt ? [cleanupStmt, insertStmt] : [insertStmt];
  });

  throwIfAborted(signal);
  await batchExecute(db, stmts, { chunkSize: STAGING_BATCH_SIZE, signal });
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
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  if (poolsFound > 0) {
    await runWithOverloadRetry(() =>
      db
        .prepare(
          `INSERT INTO dex_discovery_meta (stablecoin_id, consecutive_misses, last_crawl_at, last_hit_at)
           VALUES (?, 0, ?, ?)
           ON CONFLICT(stablecoin_id) DO UPDATE SET
             consecutive_misses = 0,
             last_crawl_at = excluded.last_crawl_at,
             last_hit_at = excluded.last_hit_at`,
        )
        .bind(stablecoinId, nowSec, nowSec)
        .run(),
      3,
      signal,
    );
    throwIfAborted(signal);
    return;
  }

  throwIfAborted(signal);
  const result = await runWithOverloadRetry(() =>
    db
      .prepare(
        "UPDATE dex_discovery_meta SET consecutive_misses = consecutive_misses + 1, last_crawl_at = ? WHERE stablecoin_id = ?",
      )
      .bind(nowSec, stablecoinId)
      .run(),
    3,
    signal,
  );

  if ((result.meta.changes ?? 0) === 0) {
    throwIfAborted(signal);
    await runWithOverloadRetry(() =>
      db
        .prepare(
          "INSERT INTO dex_discovery_meta (stablecoin_id, consecutive_misses, last_crawl_at, last_hit_at) VALUES (?, 1, ?, NULL)",
        )
        .bind(stablecoinId, nowSec)
        .run(),
      3,
      signal,
    );
  }
  throwIfAborted(signal);
}

/**
 * Cleanup stale staging data.
 * - Delete rows where refreshed_at < nowSec - 48h (172800)
 * - NULL out raw_json where refreshed_at < nowSec - 6h (21600) to save storage
 */
export async function cleanupStaging(db: D1Database, nowSec: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await batchExecute(db, [
    db
      .prepare("DELETE FROM dex_pool_staging WHERE refreshed_at < ?")
      .bind(nowSec - STAGING_DELETE_TTL_SEC),
    db
      .prepare("UPDATE dex_pool_staging SET raw_json = NULL WHERE raw_json IS NOT NULL AND refreshed_at < ?")
      .bind(nowSec - STAGING_RAW_JSON_TTL_SEC),
  ], { chunkSize: 2, signal });
  throwIfAborted(signal);
}

/**
 * Read current discovery meta for all stablecoins.
 */
export async function readDiscoveryMeta(db: D1Database, signal?: AbortSignal): Promise<Map<string, DiscoveryMeta>> {
  throwIfAborted(signal);
  const rows = await runWithOverloadRetry(() =>
    db
      .prepare("SELECT stablecoin_id, consecutive_misses, last_crawl_at, last_hit_at FROM dex_discovery_meta")
      .all<{
        stablecoin_id: string;
        consecutive_misses: number;
        last_crawl_at: number;
        last_hit_at: number | null;
      }>(),
    3,
    signal,
  );
  throwIfAborted(signal);

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
export async function incrementRunSeq(db: D1Database, signal?: AbortSignal): Promise<number> {
  throwIfAborted(signal);
  const [, readResult] = await runWithOverloadRetry(() =>
    db.batch([
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
    ]),
    3,
    signal,
  );
  throwIfAborted(signal);

  const value = (readResult.results?.[0] as { value?: string } | undefined)?.value;
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid kv_config value for ${RUN_SEQ_KEY}: ${String(value)}`);
  }
  return parsed;
}
