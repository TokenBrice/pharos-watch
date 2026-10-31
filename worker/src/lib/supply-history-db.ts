import { chunkArray, executeAtomicBatch } from "./db";
import { D1_BATCH_SIZE } from "./constants";
import { SNAPSHOT_SUPPLY_LAST_WRITE_KEY } from "./supply-snapshot-completion";

/** Shared D1 SQL for supply_history upserts. */
const SUPPLY_HISTORY_UPSERT_PREFIX =
  "INSERT OR REPLACE INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price)";

export const SUPPLY_HISTORY_UPSERT_SQL = `${SUPPLY_HISTORY_UPSERT_PREFIX} VALUES (?, ?, ?, ?)`;

/**
 * Insert-missing-only variant used by the admin supply backfill: an existing
 * `(stablecoin_id, snapshot_date)` row is left untouched, so a cron-owned
 * snapshot's `price_observed_at`/`supply_provenance` survive a backfill overlap.
 * Replacing an existing row requires the backfill's explicit `overwrite=true`.
 */
export const SUPPLY_HISTORY_INSERT_MISSING_SQL =
  "INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price) VALUES (?, ?, ?, ?) ON CONFLICT (stablecoin_id, snapshot_date) DO NOTHING";

/**
 * Daily-snapshot upsert: also records the price's actual observation clock
 * (`price_observed_at`, migration 0253) and the observation's validated
 * supply provenance (`supply_provenance` JSON, migration 0287). The admin
 * backfill above leaves both NULL (unknown), so its prices are never
 * mint/burn event-time evidence and its chain coverage is never complete.
 */
export const SUPPLY_SNAPSHOT_UPSERT_PREFIX =
  "INSERT OR REPLACE INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price, price_observed_at, supply_provenance)";

/**
 * Backfills invalidate derived history in the same transaction as each chunk.
 * Returns the number of supply rows actually inserted (D1 `changes`), so an
 * insert-missing backfill can report existing rows it skipped instead of
 * claiming them as inserts.
 */
export async function writeSupplyHistoryBatch(db: D1Database, statements: D1PreparedStatement[]): Promise<number> {
  let inserted = 0;
  for (const chunk of chunkArray(statements, D1_BATCH_SIZE - 1)) {
    const results = await executeAtomicBatch(db, [
      ...chunk,
      db.prepare(
        `UPDATE cache SET value = json_set(value, '$.historyRevision', ?)
         WHERE key = ? AND json_valid(value)`,
      ).bind(crypto.randomUUID(), SNAPSHOT_SUPPLY_LAST_WRITE_KEY),
    ], { returnResults: true });
    for (let index = 0; index < chunk.length; index++) {
      inserted += Number(results[index]?.meta?.changes ?? 0);
    }
  }
  return inserted;
}
