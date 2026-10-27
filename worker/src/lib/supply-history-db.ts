import { chunkArray, executeAtomicBatch } from "./db";
import { D1_BATCH_SIZE } from "./constants";
import { SNAPSHOT_SUPPLY_LAST_WRITE_KEY } from "./supply-snapshot-completion";

/** Shared D1 SQL for supply_history upserts. */
const SUPPLY_HISTORY_UPSERT_PREFIX =
  "INSERT OR REPLACE INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price)";

export const SUPPLY_HISTORY_UPSERT_SQL = `${SUPPLY_HISTORY_UPSERT_PREFIX} VALUES (?, ?, ?, ?)`;

/**
 * Daily-snapshot upsert: also records the price's actual observation clock
 * (`price_observed_at`, migration 0253) and the observation's validated
 * supply provenance (`supply_provenance` JSON, migration 0287). The admin
 * backfill above leaves both NULL (unknown), so its prices are never
 * mint/burn event-time evidence and its chain coverage is never complete.
 */
export const SUPPLY_SNAPSHOT_UPSERT_PREFIX =
  "INSERT OR REPLACE INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price, price_observed_at, supply_provenance)";

/** Backfills invalidate derived history in the same transaction as each chunk. */
export async function writeSupplyHistoryBatch(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  for (const chunk of chunkArray(statements, D1_BATCH_SIZE - 1)) {
    await executeAtomicBatch(db, [
      ...chunk,
      db.prepare(
        `UPDATE cache SET value = json_set(value, '$.historyRevision', ?)
         WHERE key = ? AND json_valid(value)`,
      ).bind(crypto.randomUUID(), SNAPSHOT_SUPPLY_LAST_WRITE_KEY),
    ]);
  }
}
