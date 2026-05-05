export const ACTIVE_DEPEG_PROMPT_LIMIT = 8;

const SEVERE_DEPEG_BPS = 2_500;
const EXTREME_DEPEG_BPS = 5_000;
const SEVERE_DEPEG_MIN_MCAP_USD = 50_000_000;
const EXTREME_DEPEG_MIN_MCAP_USD = 10_000_000;

export function getDepegMarketImpactScore(bps: number, mcapUsd: number): number {
  return Math.round(Math.abs(bps) * mcapUsd / 1_000_000_000 * 10) / 10;
}

export function isCriticalDepegRisk(params: { bps: number; mcapUsd: number }): boolean {
  const absBps = Math.abs(params.bps);
  return (
    absBps >= SEVERE_DEPEG_BPS && params.mcapUsd >= SEVERE_DEPEG_MIN_MCAP_USD
  ) || (
    absBps >= EXTREME_DEPEG_BPS && params.mcapUsd >= EXTREME_DEPEG_MIN_MCAP_USD
  );
}

export function getDepegEditorialImpactScore(bps: number, mcapUsd: number): number {
  const marketImpact = getDepegMarketImpactScore(bps, mcapUsd);
  const absBps = Math.abs(bps);
  if (absBps >= EXTREME_DEPEG_BPS && mcapUsd >= EXTREME_DEPEG_MIN_MCAP_USD) {
    return Math.max(marketImpact, 1_500);
  }
  if (absBps >= SEVERE_DEPEG_BPS && mcapUsd >= SEVERE_DEPEG_MIN_MCAP_USD) {
    return Math.max(marketImpact, 1_000);
  }
  return marketImpact;
}
