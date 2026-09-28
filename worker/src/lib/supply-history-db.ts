/** Shared D1 SQL for supply_history upserts. */
const SUPPLY_HISTORY_UPSERT_PREFIX =
  "INSERT OR REPLACE INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price)";

export const SUPPLY_HISTORY_UPSERT_SQL = `${SUPPLY_HISTORY_UPSERT_PREFIX} VALUES (?, ?, ?, ?)`;

/**
 * Daily-snapshot upsert: also records the price's actual observation clock
 * (`price_observed_at`, migration 0253). The admin backfill above leaves it
 * NULL (unknown), so its prices are never mint/burn event-time evidence.
 */
export const SUPPLY_SNAPSHOT_UPSERT_PREFIX =
  "INSERT OR REPLACE INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price, price_observed_at)";
