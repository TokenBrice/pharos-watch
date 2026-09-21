import type { MintBurnPriceContext } from "./types";
import { buildInClause } from "../db";
import { chunkArray } from "../collections";
import { buildPriceValidationContext, validatePriceCandidate } from "../price-validation";
import { bucketUnixSecondsToUtcDay } from "@shared/lib/time-buckets";
import { DAY_SECONDS } from "@shared/lib/time-constants";

const DEFAULT_SQL_IN_CHUNK_SIZE = 90;
const MAX_EVENT_DAY_LOOKBACK_SEC = DAY_SECONDS;

export interface MintBurnHistoricalPriceResolution {
  price: number;
  snapshotDate: number;
}

/**
 * Same peg-plausibility contract the historical price repair scanner applies
 * before it writes `amount_usd` (`historical_backfill` validation mode).
 */
function isPlausibleEventDayPrice(stablecoinId: string, price: number): boolean {
  return validatePriceCandidate(
    price,
    buildPriceValidationContext({ stablecoinId }),
    "historical_backfill",
  ).accepted;
}

export function findMintBurnHistoricalPrice(
  priceHistory: Map<string, { snapshotDate: number; price: number }[]>,
  stablecoinId: string,
  timestamp: number,
): MintBurnHistoricalPriceResolution | null {
  const eventDay = bucketUnixSecondsToUtcDay(timestamp);
  const history = priceHistory.get(stablecoinId) ?? [];

  let bestIdx = -1;
  let lo = 0;
  let hi = history.length - 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (history[mid].snapshotDate <= eventDay) {
      bestIdx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  for (let idx = bestIdx; idx >= 0; idx--) {
    const hit = history[idx];
    if (eventDay - hit.snapshotDate > MAX_EVENT_DAY_LOOKBACK_SEC) return null;
    if (!isPlausibleEventDayPrice(stablecoinId, hit.price)) continue;
    return { price: hit.price, snapshotDate: hit.snapshotDate };
  }
  return null;
}

export async function loadMintBurnPriceHistoryBatch(
  db: D1Database,
  stablecoinIds: string[],
  sqlInChunkSize = DEFAULT_SQL_IN_CHUNK_SIZE,
): Promise<Map<string, { snapshotDate: number; price: number }[]>> {
  const uniqueIds = [...new Set(stablecoinIds)];
  const priceHistory = new Map<string, { snapshotDate: number; price: number }[]>();

  if (uniqueIds.length === 0) {
    return priceHistory;
  }

  const idChunks = chunkArray(uniqueIds, sqlInChunkSize);
  for (const idChunk of idChunks) {
    const historyInClause = buildInClause(idChunk);
    const priceHistoryRows = await db
      .prepare(
        `SELECT stablecoin_id, snapshot_date, price FROM supply_history WHERE stablecoin_id IN (${historyInClause.sql}) AND price IS NOT NULL ORDER BY stablecoin_id, snapshot_date ASC`,
      )
      .bind(...historyInClause.binds)
      .all<{ stablecoin_id: string; snapshot_date: number; price: number }>();

    for (const row of priceHistoryRows.results ?? []) {
      const series = priceHistory.get(row.stablecoin_id) ?? [];
      series.push({ snapshotDate: row.snapshot_date, price: row.price });
      priceHistory.set(row.stablecoin_id, series);
    }
  }

  return priceHistory;
}

export async function loadMintBurnPriceContextBatch(
  db: D1Database,
  stablecoinIds: string[],
  sqlInChunkSize = DEFAULT_SQL_IN_CHUNK_SIZE,
): Promise<MintBurnPriceContext> {
  const uniqueIds = [...new Set(stablecoinIds)];
  const prices = new Map<string, number>();
  const priceHistory = await loadMintBurnPriceHistoryBatch(db, uniqueIds, sqlInChunkSize);

  if (uniqueIds.length === 0) {
    return { prices, priceHistory };
  }

  const idChunks = chunkArray(uniqueIds, sqlInChunkSize);
  for (const idChunk of idChunks) {
    const priceInClause = buildInClause(idChunk);
    const priceRows = await db
      .prepare(
        `SELECT asset_id, price FROM price_cache WHERE asset_id IN (${priceInClause.sql})`,
      )
      .bind(...priceInClause.binds)
      .all<{ asset_id: string; price: number }>();

    for (const row of priceRows.results ?? []) {
      prices.set(row.asset_id, row.price);
    }
  }

  return { prices, priceHistory };
}
