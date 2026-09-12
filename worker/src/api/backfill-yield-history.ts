import { batchExecute } from "../lib/db";
import { jsonResponse } from "../lib/api-response";
import { noCoinsInBatchResponse, selectBackfillCoins } from "../lib/backfill-query";
import { fetchZephyrZysSource } from "../lib/yield-source-adapters/zephyr";

const DEFAULT_BATCH_SIZE = 10;
const ZEPHYR_YIELD_SOURCE_KEY = "protocol-api:zys-zephyr-protocol";

interface BackfillYieldHistoryTarget {
  id: string;
  symbol: string;
  sourceKey: string;
}

const TARGET_YIELD_HISTORY_SOURCES: readonly BackfillYieldHistoryTarget[] = [
  {
    id: "zys-zephyr-protocol",
    symbol: "ZYS",
    sourceKey: ZEPHYR_YIELD_SOURCE_KEY,
  },
] as const;

interface CoinResult {
  id: string;
  symbol: string;
  inserted: boolean;
}

export interface BackfillYieldHistoryRouteContext {
  db: D1Database;
  url: URL;
  trustedAdmin?: boolean;
  request?: Request;
}

/**
 * B17 — a backfilled row is a historical observation, so it must not claim more than
 * the pipeline can prove. `is_best` mirrors the coin's currently published selection
 * (a backfilled row has no arbitration record of its own, and a hardcoded `1`
 * fabricated best-source points in the source-history series and the switch count),
 * `data_source` is the adapter's own lane instead of an invented
 * `protocol-api-backfill` label, and `inserted` is read back from D1 `changes` rather
 * than assumed — the route is registered as always-idempotent and
 * `INSERT OR IGNORE` can drop the row on the `(stablecoin_id, source_key,
 * recorded_at)` primary key.
 */
async function loadPublishedBestSourceKey(db: D1Database, stablecoinId: string): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT /* pharos:yield-backfill:published-best-source */
         source_key FROM yield_data
       WHERE stablecoin_id = ? AND is_best = 1
         AND (publication_generation_id IS NULL OR publication_state = 'published')
       ORDER BY pharos_yield_score DESC, apy_30d DESC
       LIMIT 1`,
    )
    .bind(stablecoinId)
    .first<{ source_key: string | null }>();
  return row?.source_key ?? null;
}

export async function handleBackfillYieldHistory({
  db,
  url,
}: BackfillYieldHistoryRouteContext): Promise<Response> {
  const selection = selectBackfillCoins(url, TARGET_YIELD_HISTORY_SOURCES, {
    defaultBatchSize: DEFAULT_BATCH_SIZE,
  });
  if ("response" in selection) {
    return selection.response;
  }
  const coins = selection.coins;

  if (coins.length === 0) {
    return noCoinsInBatchResponse();
  }

  let rowsInsertedCount = 0;
  const coinResults: CoinResult[] = [];
  const skipped: string[] = [];

  for (const coin of coins) {
    const source = await fetchZephyrZysSource();
    if (!source) {
      skipped.push(`${coin.symbol}: missing protocol response`);
      coinResults.push({ id: coin.id, symbol: coin.symbol, inserted: false });
      continue;
    }

    const publishedBestSourceKey = await loadPublishedBestSourceKey(db, coin.id);
    const isBest = publishedBestSourceKey === coin.sourceKey ? 1 : 0;
    const insertedRow = await batchExecute(db, [
      db
        .prepare(
          `INSERT OR IGNORE INTO yield_history
           (stablecoin_id, source_key, recorded_at, apy, apy_base, apy_reward, source_tvl_usd, data_source, is_best, warning_signals)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          coin.id,
          coin.sourceKey,
          source.sourceObservedAt,
          source.currentApy,
          source.apyBase,
          source.apyReward,
          source.sourceTvlUsd,
          source.dataSource,
          isBest,
          "[]",
        ),
    ]);

    rowsInsertedCount += insertedRow;
    coinResults.push({ id: coin.id, symbol: coin.symbol, inserted: insertedRow > 0 });
  }

  return jsonResponse({
    coinsProcessed: coinResults.length,
    rowsInserted: rowsInsertedCount,
    coinResults,
    skipped: skipped.length > 0 ? skipped : undefined,
  });
}
