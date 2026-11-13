/** Reviewed changes to the quantity counted as circulating, not economic supply moves. */
export const SUPPLY_PERIMETER_CHANGES = [
  {
    stablecoinId: "gho-aave",
    changedAt: Date.parse("2026-11-13T08:03:20Z") / 1000,
    chainIds: ["ethereum", "arbitrum", "monad", "plasma"],
    evidenceUrl: "https://github.com/DefiLlama/peggedassets-server/pull/987",
  },
] as const;

/** Daily rows use their UTC-midnight timestamp, including on the change's day. */
export function isEarlierSupplyPerimeter(stablecoinId: string, observedAt: number): boolean {
  return SUPPLY_PERIMETER_CHANGES.some((change) => change.stablecoinId === stablecoinId && observedAt < change.changedAt);
}

/** Totals across this boundary cannot be compared without restating their members. */
export function getLatestSupplyPerimeterChange(start: number, end: number): number | null {
  const changes = SUPPLY_PERIMETER_CHANGES.filter((change) => change.changedAt > start && change.changedAt <= end);
  return changes.length ? Math.max(...changes.map((change) => change.changedAt)) : null;
}
