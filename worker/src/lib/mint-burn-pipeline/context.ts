import type { MintBurnPriceContext } from "./types";
import { buildInClause } from "../db";
import { chunkArray } from "../collections";

const DEFAULT_SQL_IN_CHUNK_SIZE = 90;

export async function loadMintBurnPriceContext(
  db: D1Database,
  stablecoinId: string,
): Promise<MintBurnPriceContext> {
  return loadMintBurnPriceContextBatch(db, [stablecoinId]);
}

export async function loadMintBurnPriceContextBatch(
  db: D1Database,
  stablecoinIds: string[],
  sqlInChunkSize = DEFAULT_SQL_IN_CHUNK_SIZE,
): Promise<MintBurnPriceContext> {
  const uniqueIds = [...new Set(stablecoinIds)];
  const prices = new Map<string, number>();
  const priceHistory = new Map<string, { snapshotDate: number; price: number }[]>();

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

  return { prices, priceHistory };
}
