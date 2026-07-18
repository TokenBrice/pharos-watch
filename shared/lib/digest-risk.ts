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

// Critical elevation is an additive bonus, not a floor. The old 1500/1000
// floors inverted size: a $10M coin at extreme bps (raw impact ~120) floored
// to 1500 outranked a $300M coin at severe bps (raw ~939) floored to 1000,
// and the sub-$50M artifactRisk tiebreak (only applied within 25 points)
// could never counter a 500-point floor gap. A bonus keeps criticals above
// same-sized noise while preserving impact ordering among criticals.
const CRITICAL_BONUS_EXTREME = 300;
const CRITICAL_BONUS_SEVERE = 150;

export function getDepegEditorialImpactScore(bps: number, mcapUsd: number): number {
  const marketImpact = getDepegMarketImpactScore(bps, mcapUsd);
  const absBps = Math.abs(bps);
  if (absBps >= EXTREME_DEPEG_BPS && mcapUsd >= EXTREME_DEPEG_MIN_MCAP_USD) {
    return marketImpact + CRITICAL_BONUS_EXTREME;
  }
  if (absBps >= SEVERE_DEPEG_BPS && mcapUsd >= SEVERE_DEPEG_MIN_MCAP_USD) {
    return marketImpact + CRITICAL_BONUS_SEVERE;
  }
  return marketImpact;
}
