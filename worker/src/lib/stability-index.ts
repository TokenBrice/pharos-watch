/**
 * Pharos Stability Index — pure compute function.
 * See docs/plans/2026-02-25-stability-index-design.md for algorithm details.
 */

import type { ConditionBand } from "../../../src/lib/psi-colors";
export type { ConditionBand } from "../../../src/lib/psi-colors";

export interface StabilityInput {
  depegs: { bps: number; mcapUsd: number; depegAgeDays?: number }[];
  totalMcapUsd: number;
  mcap7dChangePct: number;
  dewsStressBreadth?: number;
}

export interface StabilityResult {
  score: number;
  band: ConditionBand;
  components: {
    severity: number;
    breadth: number;
    stressBreadth: number;
    trend: number;
  };
}

const K = 60;
const GRACE_DAYS = 30;
const DECAY_DAYS = 120;
const DEPRECIATION_FLOOR = 0.25;

/** Linear decay: full impact for 30d, then fades to 25% floor over 120d. */
export function getDepreciationFactor(ageDays: number): number {
  if (ageDays <= GRACE_DAYS) return 1.0;
  return Math.max(DEPRECIATION_FLOOR, 1.0 - (ageDays - GRACE_DAYS) / DECAY_DAYS);
}

export function computeStabilityIndex(input: StabilityInput): StabilityResult {
  const { depegs, totalMcapUsd, mcap7dChangePct } = input;

  const severityRaw = depegs.reduce((sum, d) => {
    const share = totalMcapUsd > 0 ? d.mcapUsd / totalMcapUsd : 0;
    const amplifier = Math.log2(1 + d.mcapUsd / 1e9);
    const factor = getDepreciationFactor(d.depegAgeDays ?? 0);
    return sum + (Math.abs(d.bps) / 100) * share * amplifier * K * factor;
  }, 0);
  const severity = Math.min(68, severityRaw);

  const breadthRaw = depegs.reduce((sum, d) => {
    const factor = getDepreciationFactor(d.depegAgeDays ?? 0);
    return sum + Math.sqrt(d.mcapUsd / 1e9) * 3 * factor;
  }, 0);
  const breadth = Math.min(17, breadthRaw);

  const safePct = Number.isFinite(mcap7dChangePct) ? mcap7dChangePct : 0;
  const trend = Math.max(-5, Math.min(5, safePct));

  // Add stress breadth from DEWS (coins under stress but not yet depegged)
  const stressBreadthRaw = input.dewsStressBreadth ?? 0;
  const stressBreadth = Math.min(5, stressBreadthRaw); // Cap at 5 additional points

  const raw = 100 - severity - breadth - stressBreadth + trend;
  const score = Math.round(Math.max(0, Math.min(100, raw)) * 10) / 10;

  return {
    score,
    band: getConditionBand(score),
    components: {
      severity: Math.round(severity * 100) / 100,
      breadth: Math.round(breadth * 100) / 100,
      stressBreadth: Math.round(stressBreadth * 100) / 100,
      trend: Math.round(trend * 100) / 100,
    },
  };
}

export function getConditionBand(score: number): ConditionBand {
  if (score >= 90) return "BEDROCK";
  if (score >= 75) return "STEADY";
  if (score >= 60) return "TREMOR";
  if (score >= 40) return "FRACTURE";
  if (score >= 20) return "CRISIS";
  return "MELTDOWN";
}

/** Re-export hex colors from shared module. */
export { PSI_HEX_COLORS as BAND_COLORS } from "../../../src/lib/psi-colors";
