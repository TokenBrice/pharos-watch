import { SUPPLY_PERIMETER_CHANGES } from "@shared/lib/supply-perimeter-changes";

/**
 * Reviewed DEC-01 missing-chain pairs (Pricing v6.80), the only authority for a CoinGecko gap-fill. A fill, new or
 * retained, needs an `eligible` pair: an on-chain read at a pinned block shows stock on the missing chain of at
 * least half the current remainder. A `refused` pair ends the fill on every path from `effectiveAt`, the asset's
 * provider-perimeter change, so comparisons across the step are withheld rather than read as a supply move;
 * before that clock it is admitted exactly as before the list existed.
 */
type ReviewedSupplyGapPair = { assetId: string; chainId: string; reviewedAt: number; evidence: string }
  & ({ decision: "eligible" } | { decision: "refused"; effectiveAt: number });

const perimeterChangedAt = (assetId: string) =>
  SUPPLY_PERIMETER_CHANGES.find((change) => change.stablecoinId === assetId)!.changedAt;

const REVIEWED_SUPPLY_GAP_PAIRS: readonly ReviewedSupplyGapPair[] = [
  {
    assetId: "usdsc-startale", chainId: "ethereum", decision: "eligible",
    reviewedAt: Date.parse("2026-11-13T20:05:00Z") / 1000,
    evidence: "Ethereum block 26408200 (2026-11-13 19:40:59 UTC): registry token 0x3f99231dd03a9f0e7e3421c92b7b90fbe012985a "
      + "totalSupply 227,897.551776 USDSC. No current remainder: CoinGecko $4,296,334 vs DefiLlama $4,273,183 (ratio 1.005).",
  },
  {
    assetId: "usdf-falcon", chainId: "solana", decision: "refused",
    reviewedAt: Date.parse("2026-11-13T13:31:00Z") / 1000,
    effectiveAt: perimeterChangedAt("usdf-falcon"),
    evidence: "Finalized Solana slot 468944023: registry mint 9ksrtYx1vnRxr4X5YqmGxqRMRBhgsc6FfQwWjB1KZq2x has zero supply "
      + "against a $163.6M remainder (2026-11-13 19:45 UTC: CoinGecko $1,720.9M vs DefiLlama $1,557.3M). The remainder "
      + "matches DefiLlama's BSC + XDC rows ($163.6M) within 0.05%: bridged supply counted twice, not Solana stock.",
  },
  {
    assetId: "wpen-ripio", chainId: "hyperevm", decision: "refused",
    reviewedAt: Date.parse("2026-11-13T20:05:00Z") / 1000,
    effectiveAt: perimeterChangedAt("wpen-ripio"),
    evidence: "HyperEVM block 51180000 (2026-11-13 19:24:42 UTC): registry token 0x4f34c8b3b5fb6d98da888f0fea543d4d9c9f2ebe "
      + "(symbol wPEN) has zero totalSupply against a $9.4K remainder (2026-11-13 19:45 UTC: CoinGecko $41,398 vs "
      + "DefiLlama $32,041).",
  },
  {
    assetId: "apxusd-apyx", chainId: "solana", decision: "refused",
    reviewedAt: Date.parse("2026-11-13T21:00:00Z") / 1000,
    effectiveAt: perimeterChangedAt("apxusd-apyx"),
    evidence: "Finalized Solana slot 468944023: registry mint HAYQtfJEQ9DbDbaHEhxfGsWbSZ3ywthdsVB3PuB72DYe holds "
      + "6,273,500.906527 apxUSD while the fill assigns about $18.9M to Solana (2026-11-13 19:45 UTC: CoinGecko $297.3M vs "
      + "DefiLlama $278.4M). That remainder equals DefiLlama's Base + BSC + Monad rows plus the Solana stock within about "
      + "1.4%, so at least $12.6M is a double count. Without the fill apxUSD publishes DefiLlama's total, which may omit "
      + "up to 6.27M of Solana supply until DefiLlama lists the chain.",
  },
];

export function reviewedGapFillDecision(
  assetId: string,
  chainId: string,
  nowSec = Date.now() / 1000,
): ReviewedSupplyGapPair["decision"] | undefined {
  const pair = REVIEWED_SUPPLY_GAP_PAIRS.find((entry) => entry.assetId === assetId && entry.chainId === chainId);
  return pair?.decision === "refused" && nowSec < pair.effectiveAt ? "eligible" : pair?.decision;
}
