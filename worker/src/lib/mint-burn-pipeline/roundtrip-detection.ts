import type { MintBurnRow } from "./types";

/**
 * Detect atomic roundtrips: transactions that contain both mint(s) and burn(s)
 * for the same stablecoin. Mutates rows in place, setting flow_type = "atomic_roundtrip".
 * Returns count of rows flagged.
 */
export function detectAtomicRoundtrips(rows: MintBurnRow[]): number {
  const groups = new Map<string, MintBurnRow[]>();
  for (const row of rows) {
    const key = `${row.tx_hash}-${row.stablecoin_id}`;
    const group = groups.get(key);
    if (group) {
      group.push(row);
    } else {
      groups.set(key, [row]);
    }
  }

  let flagged = 0;
  for (const group of groups.values()) {
    const hasMint = group.some((row) => row.direction === "mint");
    const hasBurn = group.some((row) => row.direction === "burn");
    if (hasMint && hasBurn) {
      for (const row of group) {
        row.flow_type = "atomic_roundtrip";
        flagged++;
      }
    }
  }

  return flagged;
}
