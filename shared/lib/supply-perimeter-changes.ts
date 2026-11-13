/**
 * changedAt is first publication of the redefined quantity; evidence may have been read earlier.
 * marketWide marks a step large enough to break whole-market comparisons (total all-time high,
 * market trajectories and ranges); other entries only withhold their own asset's comparisons.
 */
export const SUPPLY_PERIMETER_CHANGES = [
  {
    stablecoinId: "gho-aave",
    changedAt: Date.parse("2026-11-13T10:30:00Z") / 1000,
    chainIds: ["ethereum", "arbitrum", "monad", "plasma"],
    evidenceUrl: "https://github.com/DefiLlama/peggedassets-server/pull/987",
    marketWide: true,
  },
  // Quantoz, 2026-11-13: DefiLlama reports the issuer's XRPL treasury account as unreleased. EURQ was
  // then outside the chain dropout guard (CoinGecko detail provider), so the 03:15 UTC sync published the
  // lower figure directly; that clock is inferred from USDQ's pair, which changed in the same commit.
  {
    stablecoinId: "eurq-quantoz",
    changedAt: Date.parse("2026-11-13T03:15:41Z") / 1000,
    chainIds: ["xrpl"],
    evidenceUrl: "https://github.com/DefiLlama/peggedassets-server/commit/110fb5b87eaebe9c3f0c957967a91b6d591cf8f3",
    marketWide: false,
  },
  {
    stablecoinId: "usdq-quantoz",
    changedAt: Date.parse("2026-11-13T14:00:00Z") / 1000,
    chainIds: ["xrpl"],
    evidenceUrl: "https://github.com/DefiLlama/peggedassets-server/commit/110fb5b87eaebe9c3f0c957967a91b6d591cf8f3",
    marketWide: false,
  },
  // Pricing v6.80: reviewed refusals end CoinGecko gap-fills whose missing-chain remainder is not that chain's stock
  // (USDf: $163.6M Solana remainder double counting DefiLlama's bridged BSC + XDC rows; wPEN: $9.4K HyperEVM
  // remainder with zero supply; apxUSD: $18.9M Solana remainder against 6.27M on-chain). Each refusal takes effect
  // at this clock, so earlier published values counted the larger quantity. Set it at or after the deploy.
  {
    stablecoinId: "usdf-falcon",
    changedAt: Date.parse("2026-11-13T23:00:00Z") / 1000,
    chainIds: ["solana"],
    evidenceUrl: "https://solscan.io/token/9ksrtYx1vnRxr4X5YqmGxqRMRBhgsc6FfQwWjB1KZq2x",
    marketWide: false,
  },
  {
    stablecoinId: "wpen-ripio",
    changedAt: Date.parse("2026-11-13T23:00:00Z") / 1000,
    chainIds: ["hyperevm"],
    evidenceUrl: "https://purrsec.com/token/0x4f34c8b3b5fb6d98da888f0fea543d4d9c9f2ebe",
    marketWide: false,
  },
  {
    stablecoinId: "apxusd-apyx",
    changedAt: Date.parse("2026-11-13T23:00:00Z") / 1000,
    chainIds: ["solana"],
    evidenceUrl: "https://solscan.io/token/HAYQtfJEQ9DbDbaHEhxfGsWbSZ3ywthdsVB3PuB72DYe",
    marketWide: false,
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

/** Whole-market totals across a market-wide boundary cannot be compared without restating their members. */
export function getLatestSupplyPerimeterChange(start: number, end: number): number | null {
  const changes = SUPPLY_PERIMETER_CHANGES.filter((change) => change.marketWide && change.changedAt > start && change.changedAt <= end);
  return changes.length ? Math.max(...changes.map((change) => change.changedAt)) : null;
}
