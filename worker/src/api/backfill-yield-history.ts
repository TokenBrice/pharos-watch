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

  const insertedRows: D1PreparedStatement[] = [];
  let rowsInserted = 0;
  const coinResults: CoinResult[] = [];
  const skipped: string[] = [];

  for (const coin of coins) {
    const source = await fetchZephyrZysSource();
    if (!source) {
      skipped.push(`${coin.symbol}: missing protocol response`);
      coinResults.push({ id: coin.id, symbol: coin.symbol, inserted: false });
      continue;
    }

    insertedRows.push(
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
          "protocol-api-backfill",
          1,
          "[]",
        ),
    );
    coinResults.push({ id: coin.id, symbol: coin.symbol, inserted: true });
  }

  if (insertedRows.length > 0) {
    rowsInserted = await batchExecute(db, insertedRows);
  }

  return jsonResponse({
    coinsProcessed: coinResults.length,
    rowsInserted,
    coinResults,
    skipped: skipped.length > 0 ? skipped : undefined,
  });
}
