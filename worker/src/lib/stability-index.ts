/**
 * Pharos Stability Index (PSI) — pure compute function.
 *
 * Produces a single 0-100 score reflecting the health of the stablecoin
 * ecosystem at a point in time. Higher = more stable.
 *
 * Components (all subtracted from a 100-point baseline):
 * - Severity (max 68 pts): market-cap-weighted, log-amplified depeg depth,
 *   with linear depreciation after 30 days grace (fades to 25% floor over 120d).
 * - Breadth  (max 17 pts): square-root-scaled count of affected market cap,
 *   rewarding diversity of impact rather than just total size.
 * - Stress breadth (max  5 pts): DEWS-sourced coins under stress but not yet
 *   formally depegged — an early-warning buffer.
 * - Trend    (-5 to +5): 7-day market-cap change percent, clamped to ±5,
 *   rewarding inflows and penalising outflows.
 *
 * The score is rounded to one decimal place and mapped to a named condition
 * band (BEDROCK → MELTDOWN) for display.
 *
 * @see docs/stability-index.md for the verified algorithm specification.
 */

import type { PsiConditionBand } from "@shared/types/stability";
export type ConditionBand = PsiConditionBand;
import { clampScore, round1, roundTo } from "@shared/lib/math";
import { computePsiDepegContribution } from "@shared/lib/psi-contribution";
import { getConditionBand, PSI_COMPONENT_LIMITS } from "@shared/lib/psi-policy";

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

const GRACE_DAYS = 30;

/** Stress-breadth scale: multiplied by sqrt(mcapUsd/1e9) for each DEWS-stressed coin.
 * Must stay in sync with the live cron (cron/stability-index.ts) and the replay path
 * (lib/psi-replay.ts) — export from here to enforce a single source of truth. */
export const DEWS_STRESS_BREADTH_SCALE = 1.5;
const DECAY_DAYS = 120;
const DEPRECIATION_FLOOR = 0.25;

/** Linear decay: full impact for 30d, then fades to 25% floor over 120d. */
export function getDepreciationFactor(ageDays: number): number {
  if (ageDays <= GRACE_DAYS) return 1.0;
  return Math.max(DEPRECIATION_FLOOR, 1.0 - (ageDays - GRACE_DAYS) / DECAY_DAYS);
}

export function computeStabilityIndex(input: StabilityInput): StabilityResult | null {
  const { depegs, totalMcapUsd, mcap7dChangePct } = input;
  if (!totalMcapUsd || totalMcapUsd <= 0) {
    return null;
  }

  const contributionTotals = depegs.reduce((totals, d) => {
    const factor = getDepreciationFactor(d.depegAgeDays ?? 0);
    const contribution = computePsiDepegContribution({
      bps: d.bps,
      mcapUsd: d.mcapUsd,
      totalMcapUsd,
      factor,
    });
    totals.severity += contribution.severity;
    totals.breadth += contribution.breadth;
    return totals;
  }, { severity: 0, breadth: 0 });
  const severity = Math.min(PSI_COMPONENT_LIMITS.severity, contributionTotals.severity);
  const breadth = Math.min(PSI_COMPONENT_LIMITS.breadth, contributionTotals.breadth);

  const safePct = Number.isFinite(mcap7dChangePct) ? mcap7dChangePct : 0;
  const trend = Math.max(-PSI_COMPONENT_LIMITS.trend, Math.min(PSI_COMPONENT_LIMITS.trend, safePct));

  // Add stress breadth from DEWS (coins under stress but not yet depegged)
  const stressBreadthRaw = input.dewsStressBreadth ?? 0;
  const stressBreadth = Math.min(PSI_COMPONENT_LIMITS.stressBreadth, stressBreadthRaw);

  const raw = 100 - severity - breadth - stressBreadth + trend;
  const score = round1(clampScore(raw));

  return {
    score,
    band: getConditionBand(score),
    components: {
      severity: roundTo(severity, 2),
      breadth: roundTo(breadth, 2),
      stressBreadth: roundTo(stressBreadth, 2),
      trend: roundTo(trend, 2),
    },
  };
}

