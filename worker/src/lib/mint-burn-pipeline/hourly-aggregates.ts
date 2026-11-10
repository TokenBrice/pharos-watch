import { mintBurnSupplyProofAcceptedSql } from "../mint-burn-supply-proofs";

/**
 * Event aggregates for one hourly bucket, shared by every materializer (sync
 * recalc, retention evidence repair, heal verification) so counts, unpriced
 * counts and known subtotals are always rebuilt together. Counted flow is
 * standard mints and standard effective burns. Volumes/net are known-valuation
 * subtotals: an event without `amount_usd` adds to its side's unpriced count,
 * never to a dollar amount, so a subtotal is exact only when that count is 0.
 * `eventAlias` is a trusted literal table alias prefix such as `"event."`.
 */
export function mintBurnHourlyBucketAggregatesSql(eventAlias = ""): string {
  const e = eventAlias;
  const supply = mintBurnSupplyProofAcceptedSql(e ? e.slice(0, -1) : "mint_burn_events");
  const mint = `${e}direction = 'mint' AND ${e}flow_type = 'standard' AND ${e}burn_type IS NOT 'review_required' AND ${supply}`;
  const burn = `${e}direction = 'burn' AND ${e}burn_type = 'effective_burn' AND ${e}flow_type = 'standard' AND ${supply}`;
  // SAFETY: only the fixed predicates above and a caller-supplied literal alias are interpolated.
  return `SUM(CASE WHEN ${mint} THEN 1 ELSE 0 END) AS mint_count,
      SUM(CASE WHEN ${burn} THEN 1 ELSE 0 END) AS burn_count,
      SUM(CASE WHEN ${mint} AND ${e}amount_usd IS NULL THEN 1 ELSE 0 END) AS mint_unpriced_event_count,
      SUM(CASE WHEN ${burn} AND ${e}amount_usd IS NULL THEN 1 ELSE 0 END) AS burn_unpriced_event_count,
      SUM(CASE WHEN ${e}direction = 'mint' AND ${e}flow_type = 'standard' AND (${e}burn_type = 'review_required' OR NOT ${supply}) THEN 1 ELSE 0 END) AS mint_unresolved_event_count,
      SUM(CASE WHEN ${e}direction = 'burn' AND ${e}flow_type = 'standard'
        AND (${e}burn_type IS NULL OR ${e}burn_type NOT IN ('effective_burn', 'bridge_burn') OR NOT ${supply}) THEN 1 ELSE 0 END) AS burn_unresolved_event_count,
      COALESCE(SUM(CASE WHEN ${mint} THEN ${e}amount_usd ELSE 0 END), 0) AS mint_volume_usd,
      COALESCE(SUM(CASE WHEN ${burn} THEN ${e}amount_usd ELSE 0 END), 0) AS burn_volume_usd,
      COALESCE(SUM(CASE WHEN ${mint} THEN ${e}amount_usd WHEN ${burn} THEN -${e}amount_usd ELSE 0 END), 0) AS net_flow_usd`;
}
