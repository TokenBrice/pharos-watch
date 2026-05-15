import type { StablecoinMeta } from "../../shared/types";

export interface AttestorTierCoverageResult {
  total: number;
  withTier: number;
  withoutTier: number;
  missingIds: string[];
  /** Fraction (0..1) of independent-audit coins missing attestorTier. */
  missingRatio: number;
}

export function analyzeAttestorTierCoverage(coins: readonly StablecoinMeta[]): AttestorTierCoverageResult {
  const auditCoins = coins.filter((coin) => coin.proofOfReserves?.type === "independent-audit");
  const missingIds = auditCoins
    .filter((coin) => !coin.proofOfReserves?.attestorTier)
    .map((coin) => coin.id)
    .sort((a, b) => a.localeCompare(b));

  const total = auditCoins.length;
  const withoutTier = missingIds.length;
  const withTier = total - withoutTier;
  const missingRatio = total === 0 ? 0 : withoutTier / total;

  return { total, withTier, withoutTier, missingIds, missingRatio };
}
