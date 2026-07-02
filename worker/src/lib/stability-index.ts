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
 * @see docs/plans/2026-02-25-stability-index-design.md for full algorithm spec.
 */

import type { ConditionBand } from "@shared/lib/psi-colors";
export type { ConditionBand } from "@shared/lib/psi-colors";
import { bandFromThresholds, clampScore, round1, roundTo } from "@shared/lib/math";
import { computePsiDepegContribution } from "@shared/lib/psi-contribution";

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
  const severity = Math.min(68, contributionTotals.severity);
  const breadth = Math.min(17, contributionTotals.breadth);

  const safePct = Number.isFinite(mcap7dChangePct) ? mcap7dChangePct : 0;
  const trend = Math.max(-5, Math.min(5, safePct));

  // Add stress breadth from DEWS (coins under stress but not yet depegged)
  const stressBreadthRaw = input.dewsStressBreadth ?? 0;
  const stressBreadth = Math.min(5, stressBreadthRaw); // Cap at 5 additional points

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

/**
 * Maps a PSI score to its named condition band.
 *
 * Thresholds (inclusive lower bound):
 * - 90–100 → BEDROCK   (exceptional stability)
 * - 75–89  → STEADY    (normal operating conditions)
 * - 60–74  → TREMOR    (mild stress, monitor closely)
 * - 40–59  → FRACTURE  (significant stress, active depegs)
 * - 20–39  → CRISIS    (severe ecosystem distress)
 * -  0–19  → MELTDOWN  (systemic failure)
 *
 * @param score - PSI score in [0, 100].
 * @returns The corresponding {@link ConditionBand} label.
 */
const CONDITION_BANDS: readonly { min: number; band: ConditionBand }[] = [
  { min: 90, band: "BEDROCK" },
  { min: 75, band: "STEADY" },
  { min: 60, band: "TREMOR" },
  { min: 40, band: "FRACTURE" },
  { min: 20, band: "CRISIS" },
  { min: 0, band: "MELTDOWN" },
];

export function getConditionBand(score: number): ConditionBand {
  return bandFromThresholds(score, CONDITION_BANDS, { min: 0, band: "MELTDOWN" as const }).band;
}

/** Re-export hex colors from shared module. */
export { PSI_HEX_COLORS as BAND_COLORS } from "@shared/lib/psi-colors";
