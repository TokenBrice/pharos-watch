// Valuation-completeness reads over `mint_burn_hourly` (D11-2). Lightweight on
// purpose — no mint-burn contract registry import — so DEWS, DDR and the flow
// API share one tally definition.
import type { MintBurnValuationTally } from "@shared/lib/mint-burn-valuation";

/**
 * Stored hourly bucket value columns, in the order the hourly writer
 * (`mintBurnHourlyBucketAggregatesSql`) produces them. Volume/net columns are
 * known-valuation subtotals; NULL unpriced counts mark a legacy bucket.
 */
export const MINT_BURN_HOURLY_BUCKET_COLUMNS_SQL = `mint_count, burn_count,
       mint_unpriced_event_count, burn_unpriced_event_count,
       mint_volume_usd, burn_volume_usd, net_flow_usd`;

/**
 * Window valuation tally over stored buckets. A legacy bucket (NULL unpriced
 * count) adds nothing to the unpriced counts and counts instead as an
 * unknown-coverage hour on each side that has counted events, so it is never
 * read as complete; a side with no counted events is provably complete.
 */
export const MINT_BURN_HOURLY_VALUATION_TALLY_SQL = `SUM(COALESCE(mint_unpriced_event_count, 0)) AS unpriced_mint_event_count,
       SUM(COALESCE(burn_unpriced_event_count, 0)) AS unpriced_burn_event_count,
       SUM(CASE WHEN mint_unpriced_event_count IS NULL AND mint_count > 0 THEN 1 ELSE 0 END) AS unknown_mint_hours,
       SUM(CASE WHEN burn_unpriced_event_count IS NULL AND burn_count > 0 THEN 1 ELSE 0 END) AS unknown_burn_hours`;

export interface MintBurnValuationTallyRow {
  unpriced_mint_event_count: number | null;
  unpriced_burn_event_count: number | null;
  unknown_mint_hours: number | null;
  unknown_burn_hours: number | null;
}

/** Grouped tally row → tally. Grouped SUMs over at least one bucket are never NULL. */
export function readMintBurnValuationTallyRow(row: MintBurnValuationTallyRow): MintBurnValuationTally {
  return {
    unpricedMintEventCount: row.unpriced_mint_event_count ?? 0,
    unpricedBurnEventCount: row.unpriced_burn_event_count ?? 0,
    unknownMintHours: row.unknown_mint_hours ?? 0,
    unknownBurnHours: row.unknown_burn_hours ?? 0,
  };
}
