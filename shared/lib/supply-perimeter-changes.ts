/** changedAt is first publication of the redefined quantity; evidence may have been read earlier. */
export const SUPPLY_PERIMETER_CHANGES = [
  {
    stablecoinId: "gho-aave",
    changedAt: Date.parse("2026-11-13T10:30:00Z") / 1000,
    chainIds: ["ethereum", "arbitrum", "monad", "plasma"],
    evidenceUrl: "https://github.com/DefiLlama/peggedassets-server/pull/987",
  },
] as const;

/** Intraday observations retain their strict observation timestamp. */
export function isEarlierSupplyPerimeter(stablecoinId: string, observedAt: number): boolean {
  return SUPPLY_PERIMETER_CHANGES.some((change) => change.stablecoinId === stablecoinId && observedAt < change.changedAt);
}

/** The change day's midnight label cannot identify which quantity a daily row counted. */
export function isAmbiguousSupplyPerimeterDay(stablecoinId: string, observedAt: number): boolean {
  return SUPPLY_PERIMETER_CHANGES.some((change) => change.stablecoinId === stablecoinId
    && observedAt === Math.floor(change.changedAt / 86_400) * 86_400);
}

/** Totals across this boundary cannot be compared without restating their members. */
export function getLatestSupplyPerimeterChange(start: number, end: number): number | null {
  const changes = SUPPLY_PERIMETER_CHANGES.filter((change) => change.changedAt > start && change.changedAt <= end);
  return changes.length ? Math.max(...changes.map((change) => change.changedAt)) : null;
}
