import { REVIEWED_ONCHAIN_SUPPLY_PLANS, type OnChainSupplyExclusionConfig } from "@shared/lib/onchain-supply-probe";

export const CURATED_ONCHAIN_SUPPLY_EXCLUSIONS: Record<string, OnChainSupplyExclusionConfig> = Object.fromEntries(
  Object.entries(REVIEWED_ONCHAIN_SUPPLY_PLANS).flatMap(([id, plan]) =>
    plan.excludedBalances ? [[id, plan.excludedBalances]] : []),
);

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
