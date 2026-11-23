import { parseDetailSnapshotSourceClock } from "@shared/lib/detail-snapshot-inputs";
import { parseSupplyObservationProvenance } from "@shared/lib/supply-provenance";
import { assessFreshnessTimestamp } from "./api-freshness-age";
import { logWorkerEventArgs } from "./structured-log";
import { matchesCurrentSupplyPerimeter } from "./supply-history-db";
import type { CompletedSupplySnapshot } from "./supply-snapshot-completion";

// Served supply_history rows, shared by /api/supply-history and the detail
// snapshot-inputs route. Keep this module off the api-history/api-params stack:
// its id resolution loads the full stablecoin catalog, which snapshot-inputs excludes.

export interface SupplyHistoryRow {
  snapshot_date: number;
  circulating_usd: number;
  price: number | null;
  circulating_native?: number | null;
  valuation_price_usd?: number | null;
  valuation_observed_at_sec?: number | null;
  /** Migration 0287; NULL = coverage unrecorded (legacy, prior Worker, backfill). */
  supply_provenance?: string | null;
}

interface BatchedSupplyHistoryRow extends SupplyHistoryRow {
  stablecoin_id: string;
}

export function latestServedSupplyTimestamp(rows: SupplyHistoryRow[]): number | null {
  return rows.reduce<number | null>(
    (latest, row) => {
      const observedAt = parseSupplyObservationProvenance(row.supply_provenance).provenance?.supplyObservedAt;
      const clock = observedAt != null && observedAt > 0 ? observedAt : row.snapshot_date;
      return latest == null ? clock : Math.max(latest, clock);
    },
    null,
  );
}

export function mapSupplyHistoryRow(row: SupplyHistoryRow) {
  // Malformed metadata degrades only this row's provenance to unknown; supply and price stay intact.
  const { provenance, invalid } = parseSupplyObservationProvenance(row.supply_provenance);
  if (invalid) {
    logWorkerEventArgs("handler", "warn",
      `[supply-history] supply-provenance-invalid for snapshot_date=${row.snapshot_date}; publishing unknown coverage`);
  }
  return {
    date: row.snapshot_date,
    circulatingUsd: row.circulating_usd,
    price: provenance?.marketQuote?.price ?? row.price,
    ...(provenance?.nativeQuantityUnavailable ? { circulatingNative: null }
      : row.circulating_native == null ? {} : { circulatingNative: row.circulating_native }),
    ...(row.valuation_price_usd == null ? {} : { valuationPriceUsd: row.valuation_price_usd }),
    ...(row.valuation_observed_at_sec == null ? {} : { valuationObservedAtSec: row.valuation_observed_at_sec }),
    supplyProvenance: provenance,
  };
}

/** Exact millisecond source clock emitted by handleSupplyHistory for the given filtered rows. */
export function resolveSupplyHistoryUpdatedAtMs(
  rows: SupplyHistoryRow[],
  nowSec = Math.floor(Date.now() / 1000),
): number | null {
  const updatedAt = latestServedSupplyTimestamp(rows);
  if (updatedAt == null || assessFreshnessTimestamp(nowSec, updatedAt).reason != null) return null;
  const parsed = parseDetailSnapshotSourceClock(String(updatedAt));
  return parsed === null ? null : parsed * 1000;
}

/** Load bounded supply_history rows for a batch of canonical IDs in one indexed D1 query. */
export async function loadBatchedSupplyHistory(
  db: D1Database,
  stablecoinIds: readonly string[],
  cutoff: number,
  completedSnapshot: CompletedSupplySnapshot,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<Map<string, SupplyHistoryRow[]>> {
  const byId = new Map<string, SupplyHistoryRow[]>();
  if (stablecoinIds.length === 0) return byId;
  const result = await db
    .prepare(
      `SELECT stablecoin_id, snapshot_date, circulating_usd, price, supply_provenance,
              circulating_native, valuation_price_usd, valuation_observed_at_sec
       FROM supply_history
       WHERE stablecoin_id IN (SELECT value FROM json_each(?))
         AND snapshot_date >= ?
         AND snapshot_date <= ?
       ORDER BY stablecoin_id ASC, snapshot_date ASC`,
    )
    .bind(JSON.stringify(stablecoinIds), cutoff, completedSnapshot.snapshotDate)
    .all<BatchedSupplyHistoryRow>();
  for (const row of result.results ?? []) {
    if (!matchesCurrentSupplyPerimeter(row.stablecoin_id, row.snapshot_date, row.supply_provenance, nowSec)) continue;
    const bucket = byId.get(row.stablecoin_id);
    if (bucket) bucket.push(row);
    else byId.set(row.stablecoin_id, [row]);
  }
  return byId;
}
