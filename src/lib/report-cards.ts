/**
 * Report Card grading engine.
 *
 * Pure functions: data in, grades out. No D1, no API calls.
 * Imported by worker API handler and frontend components.
 */

import type {
  ReportCardGrade,
  ReportCardDimension,
  DimensionKey,
  PegSummaryCoin,
  DexLiquidityData,
  StablecoinMeta,
  GovernanceType,
  ReportCard,
} from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const METHODOLOGY_VERSION = "2.1";

export const DIMENSION_WEIGHTS: Record<DimensionKey, number> = {
  pegStability: 0.25,
  liquidity: 0.25,
  resilience: 0.10,
  decentralization: 0.10,
  dependencyRisk: 0.30,
};

export const DIMENSION_LABELS: Record<DimensionKey, string> = {
  pegStability: "Peg Stability",
  liquidity: "Liquidity",
  resilience: "Resilience",
  decentralization: "Decentralization",
  dependencyRisk: "Dependency Risk",
};

export const DIMENSION_SHORT_LABELS: Record<DimensionKey, string> = {
  pegStability: "Peg",
  liquidity: "Liq.",
  resilience: "Resil.",
  decentralization: "Decen.",
  dependencyRisk: "Dep.",
};

/** Sorted descending by min — first match wins. */
export const GRADE_THRESHOLDS: { grade: ReportCardGrade; min: number }[] = [
  { grade: "A+", min: 97 },
  { grade: "A", min: 93 },
  { grade: "A-", min: 90 },
  { grade: "B+", min: 85 },
  { grade: "B", min: 80 },
  { grade: "B-", min: 75 },
  { grade: "C+", min: 70 },
  { grade: "C", min: 65 },
  { grade: "C-", min: 60 },
  { grade: "D", min: 50 },
  { grade: "F", min: 0 },
];

/**
 * Static Tailwind class strings for each ReportCardGrade.
 * A-range = emerald, B-range = blue, C-range = amber, D = orange, F = red, NR = muted.
 * These MUST be static literals (Tailwind purge requirement).
 */
export const REPORT_CARD_GRADE_COLORS: Record<ReportCardGrade, string> = {
  "A+": "bg-emerald-500/10 text-emerald-500 border-emerald-500/20",
  "A":  "bg-emerald-500/10 text-emerald-500 border-emerald-500/20",
  "A-": "bg-emerald-500/10 text-emerald-500 border-emerald-500/20",
  "B+": "bg-blue-500/10 text-blue-500 border-blue-500/20",
  "B":  "bg-blue-500/10 text-blue-500 border-blue-500/20",
  "B-": "bg-blue-500/10 text-blue-500 border-blue-500/20",
  "C+": "bg-amber-500/10 text-amber-500 border-amber-500/20",
  "C":  "bg-amber-500/10 text-amber-500 border-amber-500/20",
  "C-": "bg-amber-500/10 text-amber-500 border-amber-500/20",
  "D":  "bg-orange-500/10 text-orange-500 border-orange-500/20",
  "F":  "bg-red-500/10 text-red-500 border-red-500/20",
  "NR": "bg-muted text-muted-foreground border-muted",
};

/** Canonical display order for report card dimensions. */
export const DIMENSION_ORDER: DimensionKey[] = [
  "pegStability",
  "liquidity",
  "resilience",
  "decentralization",
  "dependencyRisk",
];

/** Hex colors for radar chart fills, keyed by grade range. */
export const GRADE_RADAR_COLORS: Record<string, string> = {
  A: "#10b981",   // emerald-500
  B: "#3b82f6",   // blue-500
  C: "#f59e0b",   // amber-500
  D: "#f97316",   // orange-500
  F: "#ef4444",   // red-500
  NR: "#71717a",  // zinc-500 (muted)
};

// ---------------------------------------------------------------------------
// Grade helpers
// ---------------------------------------------------------------------------

/** Map a 0-100 score to a letter grade. null -> NR. */
export function scoreToGrade(score: number | null): ReportCardGrade {
  if (score === null) return "NR";
  const clamped = Math.max(0, Math.min(100, score));
  for (const { grade, min } of GRADE_THRESHOLDS) {
    if (clamped >= min) return grade;
  }
  return "F";
}

/** Return the broad grade range: "A", "B", "C", "D", "F", or "NR". */
export function gradeRange(grade: ReportCardGrade): string {
  if (grade === "NR") return "NR";
  // First character is the letter (A, B, C, D, F)
  return grade.charAt(0);
}

// ---------------------------------------------------------------------------
// Dimension scorers
// ---------------------------------------------------------------------------

/**
 * Peg Stability: uses pegScore from the peg summary.
 * - Caps at C (65) if activeDepeg
 * - +3 bonus if no events in 12+ months
 * - Annotates NAV tokens
 */
export function scorePegStability(
  peg: PegSummaryCoin | undefined,
  meta: StablecoinMeta,
): ReportCardDimension {
  // NAV tokens (yield-accruing, not pegged to $1) get NR
  if (meta.flags.navToken) {
    return { grade: "NR", score: null, detail: "NAV token - peg tracking not applicable" };
  }

  if (!peg || peg.pegScore === null) {
    return { grade: "NR", score: null, detail: "Insufficient peg tracking data" };
  }

  let score = peg.pegScore;

  // Cap at 65 (C) if there is an active depeg
  if (peg.activeDepeg) {
    score = Math.min(score, 65);
  }

  // Award +3 if no depeg events, or last one was 12+ months ago
  const twelveMonthsAgo = Date.now() / 1000 - 365 * 86400;
  const noRecentEvents =
    peg.eventCount === 0 ||
    (peg.lastEventAt !== null && peg.lastEventAt < twelveMonthsAgo);
  if (noRecentEvents && !peg.activeDepeg) {
    score = Math.min(100, score + 3);
  }

  score = Math.round(Math.max(0, Math.min(100, score)));

  // Build detail string
  const parts: string[] = [];
  parts.push(`Peg score: ${score}/100`);
  if (peg.activeDepeg) parts.push("(active depeg, capped at C)");
  if (peg.eventCount === 0) {
    parts.push("No depeg events recorded");
  } else {
    parts.push(`${peg.eventCount} depeg event${peg.eventCount === 1 ? "" : "s"}`);
  }
  if (peg.worstDeviationBps !== null) {
    parts.push(`worst deviation: ${peg.worstDeviationBps} bps`);
  }

  let detail = parts.join(". ");
  if (meta.flags.yieldBearing) {
    detail += " (yield-bearing — expected price appreciation excluded)";
  }

  return { grade: scoreToGrade(score), score, detail };
}

/**
 * Liquidity: uses liquidityScore from DEX liquidity data.
 * - -5 if HHI > 0.5
 * - -10 if HHI > 0.8
 * - NR if no data
 */
export function scoreLiquidity(
  liq: Pick<DexLiquidityData, "liquidityScore" | "concentrationHhi" | "poolCount" | "chainCount"> | undefined,
): ReportCardDimension {
  if (!liq || liq.liquidityScore === null) {
    return { grade: "NR", score: null, detail: "No DEX liquidity data available" };
  }

  let score = liq.liquidityScore;

  // Concentration penalty
  if (liq.concentrationHhi !== null) {
    if (liq.concentrationHhi > 0.8) {
      score -= 10;
    } else if (liq.concentrationHhi > 0.5) {
      score -= 5;
    }
  }

  score = Math.round(Math.max(0, Math.min(100, score)));

  const parts: string[] = [];
  parts.push(`Liquidity score: ${score}/100`);
  parts.push(`${liq.poolCount} pool${liq.poolCount === 1 ? "" : "s"} across ${liq.chainCount} chain${liq.chainCount === 1 ? "" : "s"}`);
  if (liq.concentrationHhi !== null && liq.concentrationHhi > 0.5) {
    parts.push(`high concentration (HHI: ${liq.concentrationHhi.toFixed(2)})`);
  }

  return { grade: scoreToGrade(score), score, detail: parts.join(". ") };
}

/**
 * Resilience: binary based on whether the token can be blacklisted by its issuer.
 *
 * Blacklistable tokens (e.g. USDC, USDT) score 0 — the issuer can freeze
 * or seize funds at any time. Non-blacklistable tokens score 100.
 */
export function scoreResilience(
  canBeBlacklisted: boolean,
): ReportCardDimension {
  const score = canBeBlacklisted ? 0 : 100;
  const detail = canBeBlacklisted
    ? "Token can be blacklisted by issuer"
    : "Token has no blacklist capability";
  return { grade: scoreToGrade(score), score, detail };
}

/**
 * Decentralization: based on governance type.
 * decentralized -> 95, centralized-dependent -> 70, centralized -> 50
 */
export function scoreDecentralization(
  governance: GovernanceType,
): ReportCardDimension {
  const scoreMap: Record<GovernanceType, number> = {
    decentralized: 95,
    "centralized-dependent": 70,
    centralized: 50,
  };

  const score = scoreMap[governance];
  const labelMap: Record<GovernanceType, string> = {
    decentralized: "Decentralized governance",
    "centralized-dependent": "CeFi-Dependent governance",
    centralized: "Centralized governance",
  };

  return { grade: scoreToGrade(score), score, detail: labelMap[governance] };
}

/**
 * Dependency Risk: for CeFi-Dependent coins, blend upstream scores by weight.
 * - Non-CeFi-Dependent: 95
 * - CeFi-Dependent with mapped deps: weighted blend of upstream + self-backed scores, -10 if any below 75
 * - CeFi-Dependent with no deps mapped or scores unavailable: 70
 */
export function scoreDependencyRisk(
  meta: StablecoinMeta,
  overallScores: Map<string, number>,
): ReportCardDimension {
  if (meta.flags.governance !== "centralized-dependent") {
    return { grade: scoreToGrade(95), score: 95, detail: "Not dependent on upstream stablecoins" };
  }

  const deps = meta.dependencies;
  if (!deps || deps.length === 0) {
    return { grade: scoreToGrade(70), score: 70, detail: "CeFi-Dependent but no upstream dependencies mapped" };
  }

  // Gather upstream scores with weights
  const resolved: { id: string; weight: number; score: number }[] = [];
  for (const dep of deps) {
    const s = overallScores.get(dep.id);
    if (s !== undefined) resolved.push({ id: dep.id, weight: dep.weight, score: s });
  }

  if (resolved.length === 0) {
    return { grade: scoreToGrade(70), score: 70, detail: "CeFi-Dependent; upstream dependency scores unavailable" };
  }

  // Blend upstream exposure with self-backed portion (non-stablecoin collateral).
  // A coin 35% backed by USDC and 65% self-backed blends: 0.35*USDC + 0.65*95.
  // Without this, dividing by totalWeight cancels out the weight entirely —
  // a 5% USDC coin would get the same dep risk score as a 100% USDC coin.
  const totalWeight = Math.min(1, resolved.reduce((sum, d) => sum + d.weight, 0));
  const selfBackedFraction = 1 - totalWeight;
  const SELF_BACKED_SCORE = 95; // same as non-dependent coins
  const blendedScore = resolved.reduce((sum, d) => sum + d.score * d.weight, 0)
    + selfBackedFraction * SELF_BACKED_SCORE;

  let score = blendedScore;

  // Penalty if any upstream scores below 75
  const weakDeps = resolved.filter((d) => d.score < 75);
  if (weakDeps.length > 0) {
    score -= 10;
  }

  score = Math.round(Math.max(0, Math.min(100, score)));

  const parts: string[] = [];
  parts.push(`Based on ${resolved.length} upstream dependenc${resolved.length === 1 ? "y" : "ies"} (${Math.round(totalWeight * 100)}% stablecoin-backed)`);
  parts.push(`blended score: ${Math.round(blendedScore)}`);
  if (weakDeps.length > 0) {
    parts.push(`-10 penalty: ${weakDeps.length} dependenc${weakDeps.length === 1 ? "y" : "ies"} below 75`);
  }

  return { grade: scoreToGrade(score), score, detail: parts.join(". ") };
}

// ---------------------------------------------------------------------------
// Overall grade computation
// ---------------------------------------------------------------------------

/**
 * Weighted sum of rated dimensions. NR dimensions have their weight redistributed.
 * Requires at least 3 rated dimensions for an overall grade, else NR.
 */
export function computeOverallGrade(
  dimensions: Record<DimensionKey, ReportCardDimension>,
): { grade: ReportCardGrade; score: number | null; ratedDimensions: number } {
  const keys = Object.keys(DIMENSION_WEIGHTS) as DimensionKey[];

  // Separate rated vs unrated
  let ratedWeight = 0;
  let weightedSum = 0;
  let ratedCount = 0;

  for (const key of keys) {
    const dim = dimensions[key];
    if (dim.score !== null) {
      ratedWeight += DIMENSION_WEIGHTS[key];
      weightedSum += dim.score * DIMENSION_WEIGHTS[key];
      ratedCount++;
    }
  }

  // Need at least 3 rated dimensions
  if (ratedCount < 3 || ratedWeight === 0) {
    return { grade: "NR", score: null, ratedDimensions: ratedCount };
  }

  // Redistribute weight from NR dimensions proportionally
  const score = Math.round(weightedSum / ratedWeight);
  const clamped = Math.max(0, Math.min(100, score));

  return { grade: scoreToGrade(clamped), score: clamped, ratedDimensions: ratedCount };
}

// ---------------------------------------------------------------------------
// Stress test recomputation
// ---------------------------------------------------------------------------

/**
 * Recompute grades with overridden overall scores for target coins.
 * Used by the stress test to simulate upstream downgrades.
 *
 * Only the Dependency Risk dimension is affected — overriding a coin's
 * overall score changes the dependency risk of every coin that lists it
 * as an upstream dependency.
 */
export function computeStressedGrades(
  cards: ReportCard[],
  overrides: Map<string, number>,  // coin ID -> synthetic overall score
): ReportCard[] {
  // Build effective overall scores map (real scores + overrides)
  const overallScores = new Map<string, number>();
  for (const card of cards) {
    const override = overrides.get(card.id);
    if (override !== undefined) {
      overallScores.set(card.id, override);
    } else if (card.overallScore !== null) {
      overallScores.set(card.id, card.overallScore);
    }
  }

  // Find which coins are directly overridden
  const overriddenIds = new Set(overrides.keys());

  // Find which coins depend on an overridden coin
  const affectedIds = new Set<string>();
  for (const card of cards) {
    const deps = card.rawInputs.dependencies;
    if (deps.length > 0 && deps.some((d) => overriddenIds.has(d.id))) {
      affectedIds.add(card.id);
    }
  }

  return cards.map((card) => {
    // Directly overridden coin: swap its overall score and grade
    if (overriddenIds.has(card.id)) {
      const newScore = overrides.get(card.id)!;
      return {
        ...card,
        overallGrade: scoreToGrade(newScore),
        overallScore: newScore,
      };
    }

    // Affected dependent coin: recompute dependency risk + overall
    if (affectedIds.has(card.id)) {
      // Build a minimal StablecoinMeta-like object for scoreDependencyRisk
      const meta = {
        flags: { governance: card.rawInputs.governanceTier },
        dependencies: card.rawInputs.dependencies,
      } as StablecoinMeta;
      const newDepRisk = scoreDependencyRisk(meta, overallScores);
      const newDimensions = { ...card.dimensions, dependencyRisk: newDepRisk };
      const overall = computeOverallGrade(newDimensions);
      return {
        ...card,
        dimensions: newDimensions,
        overallGrade: overall.grade,
        overallScore: overall.score,
        ratedDimensions: overall.ratedDimensions,
      };
    }

    // Unaffected: return as-is
    return card;
  });
}
