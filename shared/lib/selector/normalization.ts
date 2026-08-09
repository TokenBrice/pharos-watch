/**
 * Normalization functions for each scoring signal. All return `number | null`
 * and never throw; null routes through the missing-data policy in
 * `engine.ts`.
 *
 * Binding: `agents/impl-plan-drafts/02-engine.md` §5.
 */
import { clamp, hhiToDiversityScore } from "../math";
import type { BluechipGrade } from "../../types";

const BLUECHIP_LADDER: Record<BluechipGrade, number> = {
  "A+": 100,
  "A": 95,
  "A-": 90,
  "B+": 85,
  "B": 80,
  "B-": 75,
  "C+": 70,
  "C": 65,
  "C-": 60,
  "D": 40,
  "F": 10,
};

/** Identity for 0–100 scores. Clamps but passes null through. */
export function identity(x: number | null): number | null {
  if (x == null) return null;
  return clamp(x, 0, 100);
}

/** Invert a 0–100 score so higher = better (DEWS, source-risk). */
export function invert100(x: number | null): number | null {
  if (x == null) return null;
  return clamp(100 - x, 0, 100);
}

/** Pharos Yield Score can exceed 100 in outliers; clamp into [0, 100]. */
export const pegYieldScore = identity;

/**
 * Excess APY normalized concavely. Diminishing utility on tail yields.
 *   0 % excess → 0
 *   8 %+ excess → 100
 *   2 % excess → ~50
 */
export function excessApyConcave(excess: number | null): number | null {
  if (excess == null) return null;
  return 100 * Math.sqrt(clamp(excess / 8, 0, 1));
}

/**
 * 30d APY variance. v ≤ 0 → 100; v ≥ 4 → 0; linear in between.
 */
export function yieldVariance(v: number | null): number | null {
  if (v == null) return null;
  return 100 - clamp((v / 4) * 100, 0, 100);
}

/**
 * Inverted source-risk score. Per design §6, null normalizes to neutral 50;
 * Penalty + redistribute is still applied to confidence in the engine.
 *
 * The return type is `number` (never null) by contract: this is load-bearing
 * for the special-case branch in scoring.ts:scoreRow (the rawValue-null /
 * normalizedValue-non-null slot shape). The explicit overloads keep that
 * contract visible — widening the return to `number | null` here would force
 * the overloads to change too, surfacing the break in review.
 */
export function sourceRiskInverted(score: number | null): number {
  if (score == null) return 50;
  return clamp(100 - score, 0, 100);
}

/**
 * Supply log-anchored at $50B → 100. $1B ≈ 63, $10M ≈ 38.
 */
export function supplyLog(usd: number | null): number | null {
  if (usd == null) return null;
  const anchor = 50_000_000_000;
  const denom = Math.log10(anchor);
  if (denom === 0) return 0;
  const ratio = Math.log10(Math.max(usd, 1)) / denom;
  return 100 * clamp(ratio, 0, 1);
}

/** Discrete ladder for Bluechip grades. Null returns null (policy decides). */
export function bluechip(grade: BluechipGrade | null): number | null {
  if (grade == null) return null;
  const value = BLUECHIP_LADDER[grade];
  return value ?? null;
}

/** HHI 0–1 (higher = more concentrated) → diversity score 0–100. */
export function hhiToDiversity(hhi: number | null): number | null {
  if (hhi == null) return null;
  return hhiToDiversityScore(hhi);
}
