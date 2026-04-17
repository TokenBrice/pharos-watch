import type { MintBurnRow } from "./types";

/** Roundtrip is recognised only when sum(mint) ≈ sum(burn) within this fraction. */
export const ROUNDTRIP_AMOUNT_TOLERANCE = 0.005; // 0.5%

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
