import { startOfUtcDaySec } from "@shared/lib/time-buckets";

export type SupplementalOnChainSupplySource = "onchain-total-supply" | "onchain-circulating-supply";

export interface OnChainSupplyExclusionConfig {
  chain: string;
  holderAddresses: string[];
  supplySource: SupplementalOnChainSupplySource;
  historicalBackfillStartDay?: number;
}

const USG_TANGENT_BACKFILL_START_DAY = startOfUtcDaySec(new Date(Date.UTC(2026, 4, 7)));

export const CURATED_ONCHAIN_SUPPLY_EXCLUSIONS: Record<string, OnChainSupplyExclusionConfig> = {
  // Tangent mints USG inventory to PegKeeper contracts that deposit/withdraw
  // from protocol liquidity pools. Tangent's own UI excludes those live
  // balances from circulating USG, so Pharos mirrors that rule.
  "usg-tangent": {
    chain: "ethereum",
    holderAddresses: [
      "0xf89615f75c8161dc185c03020240905f6b66bad9",
      "0x8a7f16508d1e8b48bdf36023f378cc04d9506d4e",
    ],
    supplySource: "onchain-circulating-supply",
    historicalBackfillStartDay: USG_TANGENT_BACKFILL_START_DAY,
  },
};

export function getOnChainSupplyExclusionConfig(stablecoinId: string): OnChainSupplyExclusionConfig | undefined {
  return CURATED_ONCHAIN_SUPPLY_EXCLUSIONS[stablecoinId];
}

export function computeExcludedBalanceAdjustedSupplyRaw(
  totalSupplyRaw: bigint,
  excludedBalancesRaw: readonly bigint[],
): bigint | null {
  if (totalSupplyRaw <= 0n) return null;

  let excludedRaw = 0n;
  for (const balanceRaw of excludedBalancesRaw) {
    if (balanceRaw < 0n) return null;
    excludedRaw += balanceRaw;
  }

  const adjustedRaw = totalSupplyRaw - excludedRaw;
  return adjustedRaw > 0n ? adjustedRaw : null;
}
