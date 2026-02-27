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
  BackingType,
  ChainRisk,
  CollateralQuality,
  CustodyModel,
  ReportCard,
  DependencyType,
  ReserveRisk,
  ReserveSlice,
} from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const METHODOLOGY_VERSION = "4.0";

/**
 * Base dimension weights for the overall grade.
 * Peg Stability has weight 0 here — it is applied as a post-hoc power-curve
 * multiplier via PEG_MULTIPLIER_EXPONENT instead (see computeOverallGrade).
 */
export const DIMENSION_WEIGHTS: Record<DimensionKey, number> = {
  pegStability: 0,
  liquidity: 0.25,
  resilience: 0.25,
  decentralization: 0.10,
  dependencyRisk: 0.30,
};

/** Peg stability multiplier: final = base × (PSI/100)^exponent */
export const PEG_MULTIPLIER_EXPONENT = 0.20;

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

/** Sorted descending by min — first match wins. Lowered 5pts in v4.0 to
 *  compensate for structural deflation from removing peg from the base. */
export const GRADE_THRESHOLDS: { grade: ReportCardGrade; min: number }[] = [
  { grade: "A+", min: 92 },
  { grade: "A", min: 88 },
  { grade: "A-", min: 85 },
  { grade: "B+", min: 80 },
  { grade: "B", min: 75 },
  { grade: "B-", min: 70 },
  { grade: "C+", min: 65 },
  { grade: "C", min: 60 },
  { grade: "C-", min: 55 },
  { grade: "D", min: 45 },
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

  let score = Math.round(Math.max(0, Math.min(100, peg.pegScore)));
  if (peg.activeDepeg) score = Math.min(65, score);

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
 * Liquidity: uses liquidityScore from DEX liquidity data as-is.
 * The composite score already factors in pool quality, diversity, and durability.
 * NR if no data.
 */
export function scoreLiquidity(
  liq: Pick<DexLiquidityData, "liquidityScore" | "concentrationHhi" | "poolCount" | "chainCount"> | undefined,
): ReportCardDimension {
  if (!liq || liq.liquidityScore === null) {
    return { grade: "NR", score: null, detail: "No DEX liquidity data available" };
  }

  const score = Math.round(Math.max(0, Math.min(100, liq.liquidityScore)));

  const parts: string[] = [];
  parts.push(`Liquidity score: ${score}/100`);
  parts.push(`${liq.poolCount} pool${liq.poolCount === 1 ? "" : "s"} across ${liq.chainCount} chain${liq.chainCount === 1 ? "" : "s"}`);
  if (liq.concentrationHhi !== null && liq.concentrationHhi > 0.5) {
    parts.push(`high concentration (HHI: ${liq.concentrationHhi.toFixed(2)})`);
  }

  return { grade: scoreToGrade(score), score, detail: parts.join(". ") };
}

// ---------------------------------------------------------------------------
// Resilience: 4-factor model
// ---------------------------------------------------------------------------

const CHAIN_RISK_SCORE: Record<ChainRisk, number> = {
  ethereum: 100,
  "stage1-l2": 66,
  "established-alt-l1": 20,
  unproven: 0,
};

const COLLATERAL_QUALITY_SCORE: Record<CollateralQuality, number> = {
  native: 100,
  rwa: 50,
  "eth-lst": 66,
  "alt-lst-bridged-or-mixed": 20,
  exotic: 0,
};

const RESERVE_QUALITY_SCORE: Record<ReserveRisk, number> = {
  "very-low": 100,
  low: 75,
  medium: 50,
  high: 25,
  "very-high": 5,
};

const COLLATERAL_QUALITY_DISPLAY: [number, string][] = [
  [88, "Very low risk"],
  [62, "Low risk"],
  [37, "Medium risk"],
  [15, "High risk"],
  [0, "Very high risk"],
];

export function computeCollateralQualityFromReserves(reserves: ReserveSlice[]): number {
  const totalPct = reserves.reduce((s, r) => s + r.pct, 0);
  if (totalPct === 0) return 0;
  const weighted = reserves.reduce(
    (s, r) => s + r.pct * RESERVE_QUALITY_SCORE[r.risk],
    0,
  );
  return Math.round(weighted / totalPct);
}

function collateralScoreLabel(score: number): string {
  for (const [threshold, label] of COLLATERAL_QUALITY_DISPLAY) {
    if (score >= threshold) return label;
  }
  return "Very high risk";
}

/**
 * Detect drift between computed reserve quality and enum classification.
 * Returns warnings for coins where the two disagree by more than 30 points.
 * Run during build or as a manual audit.
 */
export function validateCollateralQualityDrift(
  coins: StablecoinMeta[],
): string[] {
  const warnings: string[] = [];
  for (const coin of coins) {
    if (!coin.reserves || coin.reserves.length === 0) continue;
    const computed = computeCollateralQualityFromReserves(coin.reserves);
    const factors = resolveResilienceFactors(coin);
    const enumScore = COLLATERAL_QUALITY_SCORE[factors.collateralQuality];
    const drift = Math.abs(computed - enumScore);
    if (drift > 30) {
      warnings.push(
        `${coin.symbol} (${coin.id}): reserve-derived=${computed}, enum=${enumScore}, drift=${drift}`,
      );
    }
  }
  return warnings;
}

const CUSTODY_MODEL_SCORE: Record<CustodyModel, number> = {
  onchain: 100,
  institutional: 50,
  cex: 0,
};

const CHAIN_RISK_LABEL: Record<ChainRisk, string> = {
  ethereum: "Ethereum mainnet",
  "stage1-l2": "Stage 1+ L2",
  "established-alt-l1": "Established alt-L1",
  unproven: "Unproven chain",
};

const COLLATERAL_QUALITY_LABEL: Record<CollateralQuality, string> = {
  native: "Native assets (ETH/BTC)",
  rwa: "Real-world assets (off-chain)",
  "eth-lst": "Ethereum LSTs",
  "alt-lst-bridged-or-mixed": "Alt-L1 LSTs / Bridged / Mixed",
  exotic: "Exotic / opaque strategy",
};

const CUSTODY_MODEL_LABEL: Record<CustodyModel, string> = {
  onchain: "Fully on-chain",
  institutional: "Institutional custodian",
  cex: "CEX / off-exchange custody",
};

/**
 * Infer default resilience sub-factors from backing + governance.
 * Only used when the field is not explicitly set on StablecoinMeta.
 */
export function inferResilienceDefaults(
  backing: BackingType,
  governance: GovernanceType,
): { chainRisk: ChainRisk; collateralQuality: CollateralQuality; custodyModel: CustodyModel } {
  if (backing === "rwa-backed" && governance === "centralized") {
    return { chainRisk: "ethereum", collateralQuality: "rwa", custodyModel: "institutional" };
  }
  if (backing === "rwa-backed" && governance === "centralized-dependent") {
    return { chainRisk: "ethereum", collateralQuality: "rwa", custodyModel: "institutional" };
  }
  if (backing === "crypto-backed" && governance === "decentralized") {
    return { chainRisk: "ethereum", collateralQuality: "native", custodyModel: "onchain" };
  }
  if (backing === "crypto-backed" && governance === "centralized-dependent") {
    return { chainRisk: "ethereum", collateralQuality: "eth-lst", custodyModel: "onchain" };
  }
  // algorithmic + any, or any remaining combo
  return { chainRisk: "ethereum", collateralQuality: "native", custodyModel: "onchain" };
}

/**
 * Resolve the final resilience sub-factor values for a coin.
 * Explicit overrides on meta take priority; otherwise, infer from backing + governance.
 */
export function resolveResilienceFactors(meta: StablecoinMeta): {
  chainRisk: ChainRisk;
  collateralQuality: CollateralQuality;
  custodyModel: CustodyModel;
} {
  const defaults = inferResilienceDefaults(meta.flags.backing, meta.flags.governance);
  return {
    chainRisk: meta.chainRisk ?? defaults.chainRisk,
    collateralQuality: meta.collateralQuality ?? defaults.collateralQuality,
    custodyModel: meta.custodyModel ?? defaults.custodyModel,
  };
}

/**
 * Resilience: 4-factor weighted average.
 *
 * Sub-factors (each 25% of the resilience score):
 * 1. Chain Risk — where does the protocol live?
 * 2. Collateral Quality — trust assumptions in backing assets
 * 3. Custody Model — who holds the collateral?
 * 4. Blacklist Capability — can the issuer freeze funds?
 */
export function scoreResilience(
  meta: StablecoinMeta,
  canBeBlacklisted: boolean | "possible",
): ReportCardDimension {
  const factors = resolveResilienceFactors(meta);
  const blacklistScore = canBeBlacklisted === true ? 0 : canBeBlacklisted === "possible" ? 50 : 100;
  const blacklistLabel = canBeBlacklisted === true ? "Yes" : canBeBlacklisted === "possible" ? "Possible (mutable contract)" : "No";

  const chainScore = CHAIN_RISK_SCORE[factors.chainRisk];
  const custodyScore = CUSTODY_MODEL_SCORE[factors.custodyModel];

  // Prefer computed score from curated reserves; fall back to enum
  const hasReserves = meta.reserves && meta.reserves.length > 0;
  const collateralScore = hasReserves
    ? computeCollateralQualityFromReserves(meta.reserves!)
    : COLLATERAL_QUALITY_SCORE[factors.collateralQuality];
  const collateralLabel = hasReserves
    ? collateralScoreLabel(collateralScore)
    : COLLATERAL_QUALITY_LABEL[factors.collateralQuality];

  const score = Math.round(
    (chainScore + collateralScore + custodyScore + blacklistScore) / 4,
  );

  const parts = [
    `Chain: ${CHAIN_RISK_LABEL[factors.chainRisk]} (${chainScore})`,
    `Collateral: ${collateralLabel} (${collateralScore})`,
    `Custody: ${CUSTODY_MODEL_LABEL[factors.custodyModel]} (${custodyScore})`,
    `Blacklist: ${blacklistLabel} (${blacklistScore})`,
  ];

  return { grade: scoreToGrade(score), score, detail: parts.join(". ") };
}

/**
 * Decentralization: governance type + chain-risk modifier.
 *
 * Base scores: decentralized 100, centralized-dependent 50, centralized 0.
 * Chain penalty: protocols on less decentralized chains get a reduction
 * because governance decentralization is undermined when the underlying
 * chain itself has centralisation concerns (validator set, halt risk, etc.).
 */
export function scoreDecentralization(
  governance: GovernanceType,
  meta?: StablecoinMeta,
): ReportCardDimension {
  const scoreMap: Record<GovernanceType, number> = {
    decentralized: 100,
    "centralized-dependent": 50,
    centralized: 0,
  };

  let score = scoreMap[governance];

  // Chain-risk penalty (only meaningful for non-centralized governance)
  const chainPenalty: Record<ChainRisk, number> = {
    ethereum: 0,
    "stage1-l2": -15,
    "established-alt-l1": -50,
    unproven: -65,
  };
  const chainRisk = meta?.chainRisk;
  const penalty = chainRisk ? (chainPenalty[chainRisk] ?? 0) : 0;
  if (governance !== "centralized" && penalty < 0) {
    score = Math.max(0, score + penalty);
  }

  const labelMap: Record<GovernanceType, string> = {
    decentralized: "Decentralized governance",
    "centralized-dependent": "CeFi-Dependent governance",
    centralized: "Centralized governance",
  };

  let detail = labelMap[governance];
  if (penalty < 0) {
    detail += ` (${CHAIN_RISK_LABEL[chainRisk!]}: ${penalty} penalty)`;
  }

  return { grade: scoreToGrade(score), score, detail };
}

/**
 * Dependency Risk: for CeFi-Dependent coins, blend upstream scores by weight.
 * - Non-CeFi-Dependent: 95
 * - CeFi-Dependent with mapped deps: weighted blend of upstream + self-backed (75) scores, -10 if any below 75
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
  const resolved: { id: string; weight: number; score: number; type: DependencyType }[] = [];
  for (const dep of deps) {
    const s = overallScores.get(dep.id);
    if (s !== undefined) resolved.push({ id: dep.id, weight: dep.weight, score: s, type: dep.type ?? "collateral" });
  }

  if (resolved.length === 0) {
    return { grade: scoreToGrade(70), score: 70, detail: "CeFi-Dependent; upstream dependency scores unavailable" };
  }

  // Blend upstream exposure with self-backed portion (non-stablecoin collateral).
  // A coin 35% backed by USDC and 65% self-backed blends: 0.35*USDC + 0.65*75.
  // Without this, dividing by totalWeight cancels out the weight entirely —
  // a 5% USDC coin would get the same dep risk score as a 100% USDC coin.
  // Self-backed score is 75 (not 95) because CeFi-Dependent coins still carry
  // systemic coupling risk — their peg mechanisms (PSMs, arbitrage loops) depend
  // on upstream stablecoin infrastructure even for the non-stablecoin collateral.
  const rawTotal = resolved.reduce((sum, d) => sum + d.weight, 0);
  const totalWeight = Math.min(1, rawTotal);
  const selfBackedFraction = 1 - totalWeight;
  const SELF_BACKED_SCORE = 75;
  const normalizer = rawTotal > 1 ? rawTotal : 1;
  const blendedScore = resolved.reduce((sum, d) => sum + d.score * (d.weight / normalizer), 0)
    + selfBackedFraction * SELF_BACKED_SCORE;

  let score = blendedScore;

  // Penalty if any upstream scores below 75
  const weakDeps = resolved.filter((d) => d.score < 75);
  if (weakDeps.length > 0) {
    score -= 10;
  }

  // Ceiling: wrapper/mechanism deps cap the final score
  const WRAPPER_PENALTY = 3;
  let ceiling = Infinity;
  for (const d of resolved) {
    if (d.type === "wrapper") ceiling = Math.min(ceiling, d.score - WRAPPER_PENALTY);
    else if (d.type === "mechanism") ceiling = Math.min(ceiling, d.score);
  }
  if (ceiling < Infinity) score = Math.min(score, ceiling);

  score = Math.round(Math.max(0, Math.min(100, score)));

  const parts: string[] = [];
  parts.push(`Based on ${resolved.length} upstream dependenc${resolved.length === 1 ? "y" : "ies"} (${Math.round(totalWeight * 100)}% stablecoin-backed)`);
  parts.push(`blended score: ${Math.round(blendedScore)}`);
  if (weakDeps.length > 0) {
    parts.push(`-10 penalty: ${weakDeps.length} dependenc${weakDeps.length === 1 ? "y" : "ies"} below 75`);
  }
  if (ceiling < Infinity) {
    const ceilingType = resolved.some(d => d.type === "wrapper") ? "wrapper" : "mechanism-critical";
    parts.push(`capped at ${Math.round(ceiling)} (${ceilingType} dependency ceiling)`);
  }

  return { grade: scoreToGrade(score), score, detail: parts.join(". ") };
}

// ---------------------------------------------------------------------------
// Overall grade computation
// ---------------------------------------------------------------------------

/**
 * 4-factor base score (liquidity, resilience, decentralization, dependency risk)
 * with peg stability applied as a post-hoc power-curve multiplier.
 *
 * Base = weighted average of rated non-peg dimensions (NR dimensions redistribute).
 * Final = base × (PSI / 100) ^ PEG_MULTIPLIER_EXPONENT
 *
 * PSI = null (NAV token / no data) → multiplier = 1.0 (no penalty).
 * PSI = 0 (dead coin) → multiplier = 0.
 *
 * Requires at least 2 rated base dimensions for an overall grade, else NR.
 */
export function computeOverallGrade(
  dimensions: Record<DimensionKey, ReportCardDimension>,
): { grade: ReportCardGrade; score: number | null; ratedDimensions: number } {
  const keys = Object.keys(DIMENSION_WEIGHTS) as DimensionKey[];

  // Compute base score from non-peg dimensions
  let ratedWeight = 0;
  let weightedSum = 0;
  let baseRatedCount = 0;

  for (const key of keys) {
    if (key === "pegStability") continue; // applied as multiplier below
    const dim = dimensions[key];
    if (dim.score !== null) {
      ratedWeight += DIMENSION_WEIGHTS[key];
      weightedSum += dim.score * DIMENSION_WEIGHTS[key];
      baseRatedCount++;
    }
  }

  // Need at least 2 rated base dimensions
  if (baseRatedCount < 2 || ratedWeight === 0) {
    return { grade: "NR", score: null, ratedDimensions: baseRatedCount };
  }

  // Redistribute weight from NR dimensions proportionally
  let score = weightedSum / ratedWeight;

  // Apply peg stability as a power-curve multiplier
  const pegScore = dimensions.pegStability.score;
  if (pegScore !== null) {
    score *= pegScore === 0 ? 0 : Math.pow(pegScore / 100, PEG_MULTIPLIER_EXPONENT);
  }
  // pegScore === null → multiplier 1.0, no change

  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  const ratedDimensions = baseRatedCount + (pegScore !== null ? 1 : 0);

  return { grade: scoreToGrade(clamped), score: clamped, ratedDimensions };
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
