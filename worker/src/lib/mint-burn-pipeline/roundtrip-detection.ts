import type { MintBurnRow } from "./types";

/** Roundtrip is recognised only when sum(mint) ≈ sum(burn) within this fraction. */
export const ROUNDTRIP_AMOUNT_TOLERANCE = 0.005; // 0.5%

/**
 * SQL HAVING fragment that mirrors `detectAtomicRoundtrips` for GROUP BY queries
 * over `mint_burn_events`. Interpolate directly (no bind placeholders) after a
 * `HAVING COUNT(DISTINCT direction) > 1 AND …` or similar.
 *
 * `CASE WHEN a >= b THEN a ELSE b END` is used in place of `MAX(a, b)` because
 * SQLite's scalar-variadic `MAX()` is unreliable inside aggregate HAVING on
 * older D1 builds. The literal `0.005` is deliberately interpolated from
 * `ROUNDTRIP_AMOUNT_TOLERANCE` so a change here propagates to both SQL sites.
 */
export const ROUNDTRIP_TOLERANCE_HAVING_SQL = `
  ABS(SUM(CASE WHEN direction='mint' THEN amount ELSE 0 END)
    - SUM(CASE WHEN direction='burn' THEN amount ELSE 0 END))
  <= ${ROUNDTRIP_AMOUNT_TOLERANCE} * (
       CASE
         WHEN SUM(CASE WHEN direction='mint' THEN amount ELSE 0 END)
            >= SUM(CASE WHEN direction='burn' THEN amount ELSE 0 END)
         THEN SUM(CASE WHEN direction='mint' THEN amount ELSE 0 END)
         ELSE SUM(CASE WHEN direction='burn' THEN amount ELSE 0 END)
       END
     )
`;

/**
 * Detect atomic roundtrips: transactions whose mint and burn totals (per stablecoin)
 * round-trip within `ROUNDTRIP_AMOUNT_TOLERANCE`. Mutates rows in place to set
 * `flow_type = "atomic_roundtrip"`. Rows missing tx_hash are skipped (defensive
 * guard against malformed input). Returns count of rows flagged.
 */
export function detectAtomicRoundtrips(rows: MintBurnRow[]): number {
  const groups = new Map<string, MintBurnRow[]>();
  for (const row of rows) {
    if (!row.tx_hash) continue;
    const key = `${row.tx_hash}-${row.stablecoin_id}`;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  let flagged = 0;
  for (const group of groups.values()) {
    let mintTotal = 0;
    let burnTotal = 0;
    for (const row of group) {
      if (row.direction === "mint") mintTotal += row.amount;
      else burnTotal += row.amount;
    }
    if (mintTotal === 0 || burnTotal === 0) continue;
    const denom = Math.max(mintTotal, burnTotal);
    if (Math.abs(mintTotal - burnTotal) > denom * ROUNDTRIP_AMOUNT_TOLERANCE) continue;
    for (const row of group) {
      row.flow_type = "atomic_roundtrip";
      flagged++;
    }
  }
  return flagged;
}
