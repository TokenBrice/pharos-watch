import { batchExecute } from "../../lib/db";
import { rethrowIfAborted, throwIfAborted } from "../../lib/abort";
import { runWithOverloadRetry } from "../../lib/d1-overload-retry";
import { toErrorMessage } from "../../lib/error-utils";
import { tryParseJson } from "../../lib/json-parse";
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
const STAGING_DELETE_TTL_SEC = 30 * 60 * 60;
const STAGING_RAW_JSON_TTL_SEC = 4 * 60 * 60;
const STAGING_CLEANUP_MAX_ROWS_PER_RUN = 1_000;
const RUN_SEQ_KEY = "discovery_run_seq";
const TARGET_CURSOR_KEY = "discovery_target_cursors";
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
  // This arithmetic update is intentionally not retried: after an ambiguous D1
  // timeout the first attempt may already have committed, and retrying would
  // double-count the miss for the same crawl.
  const result = await db
    .prepare(
      "UPDATE dex_discovery_meta SET consecutive_misses = consecutive_misses + 1, last_crawl_at = ? WHERE stablecoin_id = ?",
    )
    .bind(nowSec, stablecoinId)
    .run();

  if ((result.meta.changes ?? 0) === 0) {
    throwIfAborted(signal);
    await db
      .prepare(
        "INSERT OR IGNORE INTO dex_discovery_meta (stablecoin_id, consecutive_misses, last_crawl_at, last_hit_at) VALUES (?, 1, ?, NULL)",
      )
      .bind(stablecoinId, nowSec)
      .run();
  }
  throwIfAborted(signal);
}

/**
 * Persist a discovery-attempt boundary without changing its backoff counters.
 * Callers write this before network work so an abort, budget discard, or later
 * persistence failure cannot leave an older verified-empty outcome current.
 */
export async function recordDiscoveryAttemptFence(
  db: D1Database,
  stablecoinId: string,
  nowSec: number,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  await runWithOverloadRetry(
    () =>
      db
        .prepare(
          `INSERT INTO dex_discovery_meta
             (stablecoin_id, consecutive_misses, last_crawl_at, last_hit_at)
           VALUES (?, 0, ?, NULL)
           ON CONFLICT(stablecoin_id) DO UPDATE SET
             last_crawl_at = excluded.last_crawl_at`,
        )
        .bind(stablecoinId, nowSec)
        .run(),
    3,
    signal,
  );
  throwIfAborted(signal);
}

/**
 * Cleanup stale staging data.
 * - Delete rows older than 30 hours, preserving the complete 24-hour scoring window.
 * - NULL raw provider payloads after four hours.
 * - Bound both oldest-first passes so a retention shortening drains gradually.
 */
export interface DexPoolStagingRetentionResult {
  rowCutoff: number;
  rawJsonCutoff: number;
  deletedRows: number;
  rawJsonClearedRows: number;
  oldestRemainingAt: number | null;
  oldestRawJsonRemainingAt: number | null;
  durationMs: number;
  error: string | null;
}

export async function cleanupStaging(
  db: D1Database,
  nowSec: number,
  signal?: AbortSignal,
): Promise<DexPoolStagingRetentionResult> {
  const startedAtMs = Date.now();
  const result: DexPoolStagingRetentionResult = {
    rowCutoff: nowSec - STAGING_DELETE_TTL_SEC,
    rawJsonCutoff: nowSec - STAGING_RAW_JSON_TTL_SEC,
    deletedRows: 0,
    rawJsonClearedRows: 0,
    oldestRemainingAt: null,
    oldestRawJsonRemainingAt: null,
    durationMs: 0,
    error: null,
  };
  try {
    const deleted = await runWithOverloadRetry(
      () => db
        .prepare(
          `DELETE FROM dex_pool_staging
            WHERE rowid IN (
              SELECT rowid
                FROM dex_pool_staging
               WHERE refreshed_at < ?
               ORDER BY refreshed_at ASC, rowid ASC
               LIMIT ?
            )`,
        )
        .bind(result.rowCutoff, STAGING_CLEANUP_MAX_ROWS_PER_RUN)
        .run(),
      3,
      signal,
    );
    result.deletedRows = Number(deleted.meta?.changes ?? 0);
    const rawJson = await runWithOverloadRetry(
      () => db
        .prepare(
          `UPDATE dex_pool_staging
              SET raw_json = NULL
            WHERE rowid IN (
              SELECT rowid
                FROM dex_pool_staging
               WHERE raw_json IS NOT NULL
                 AND refreshed_at < ?
               ORDER BY refreshed_at ASC, rowid ASC
               LIMIT ?
            )`,
        )
        .bind(result.rawJsonCutoff, STAGING_CLEANUP_MAX_ROWS_PER_RUN)
        .run(),
      3,
      signal,
    );
    result.rawJsonClearedRows = Number(rawJson.meta?.changes ?? 0);
    const oldest = await runWithOverloadRetry(
      () => db
        .prepare(
          `SELECT MIN(refreshed_at) AS oldest_remaining_at,
                  MIN(CASE WHEN raw_json IS NOT NULL THEN refreshed_at END) AS oldest_raw_json_remaining_at
             FROM dex_pool_staging`,
        )
        .first<{
          oldest_remaining_at: number | null;
          oldest_raw_json_remaining_at: number | null;
        }>(),
      3,
      signal,
    );
    result.oldestRemainingAt = oldest?.oldest_remaining_at ?? null;
    result.oldestRawJsonRemainingAt = oldest?.oldest_raw_json_remaining_at ?? null;
  } catch (error) {
    rethrowIfAborted(error, signal);
    result.error = toErrorMessage(error).slice(0, 500);
  }
  result.durationMs = Math.max(0, Date.now() - startedAtMs);
  return result;
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
  // Do not retry this sequence increment after an ambiguous D1 timeout. A
  // committed first attempt plus retry would skip a discovery cohort.
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
  throwIfAborted(signal);

  const value = (readResult.results?.[0] as { value?: string } | undefined)?.value;
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid kv_config value for ${RUN_SEQ_KEY}: ${String(value)}`);
  }
  return parsed;
}

/**
 * Read the per-coin deployment-window resume markers. One kv_config row holds the
 * whole map so a run pays a single read and a single write instead of one per
 * coin. A malformed payload degrades to "no cursor", which restarts every
 * rotation from the first deployment rather than stalling the crawl.
 */
export async function readDiscoveryTargetCursors(
  db: D1Database,
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  throwIfAborted(signal);
  const row = await runWithOverloadRetry(
    () =>
      db
        .prepare("SELECT value FROM kv_config WHERE key = ?")
        .bind(TARGET_CURSOR_KEY)
        .first<{ value?: string }>(),
    3,
    signal,
  );
  throwIfAborted(signal);

  const cursors = new Map<string, string>();
  const parsed = tryParseJson(row?.value, "dex discovery target cursors");
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return cursors;
  for (const [stablecoinId, cursor] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof cursor === "string" && cursor.length > 0) {
      cursors.set(stablecoinId, cursor);
    }
  }
  return cursors;
}

export async function writeDiscoveryTargetCursors(
  db: D1Database,
  cursors: ReadonlyMap<string, string>,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  await runWithOverloadRetry(
    () =>
      db
        .prepare(
          `INSERT INTO kv_config (key, value)
           VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .bind(TARGET_CURSOR_KEY, JSON.stringify(Object.fromEntries(cursors)))
        .run(),
    3,
    signal,
  );
  throwIfAborted(signal);
}
