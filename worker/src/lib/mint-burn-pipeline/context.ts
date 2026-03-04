import type { MintBurnPriceContext } from "./types";

const DEFAULT_SQL_IN_CHUNK_SIZE = 90;

function chunkArray<T>(values: T[], chunkSize: number): T[][] {
  if (values.length === 0) return [];
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += chunkSize) {
    chunks.push(values.slice(i, i + chunkSize));
  }
  return chunks;
}

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
    const priceRows = await db
      .prepare(
        "SELECT asset_id, price FROM price_cache WHERE asset_id IN (" +
        idChunk.map(() => "?").join(",") +
        ")",
      )
      .bind(...idChunk)
      .all<{ asset_id: string; price: number }>();

    for (const row of priceRows.results ?? []) {
      prices.set(row.asset_id, row.price);
    }
  }

  for (const idChunk of idChunks) {
    const priceHistoryRows = await db
      .prepare(
        "SELECT stablecoin_id, snapshot_date, price FROM supply_history WHERE stablecoin_id IN (" +
        idChunk.map(() => "?").join(",") +
        ") AND price IS NOT NULL ORDER BY stablecoin_id, snapshot_date ASC",
      )
      .bind(...idChunk)
      .all<{ stablecoin_id: string; snapshot_date: number; price: number }>();

    for (const row of priceHistoryRows.results ?? []) {
      const series = priceHistory.get(row.stablecoin_id) ?? [];
      series.push({ snapshotDate: row.snapshot_date, price: row.price });
      priceHistory.set(row.stablecoin_id, series);
    }
  }

  return { prices, priceHistory };
}
