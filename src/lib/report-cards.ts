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
  GovernanceQuality,
  BackingType,
  ChainTier,
  DeploymentModel,
  CollateralQuality,
  CustodyModel,
  ReportCard,
  DependencyType,
  ReserveRisk,
  ReserveSlice,
} from "./types";
import { deriveDependencies } from "./reserve-templates";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const METHODOLOGY_VERSION = "5.3";

/**
 * Base dimension weights for the overall grade.
 * Peg Stability has weight 0 here — it is applied as a post-hoc power-curve
 * multiplier via PEG_MULTIPLIER_EXPONENT instead (see computeOverallGrade).
 */
export const DIMENSION_WEIGHTS: Record<DimensionKey, number> = {
  pegStability: 0,
  liquidity: 0.30,
  resilience: 0.20,
  decentralization: 0.15,
  dependencyRisk: 0.25,
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
 *  compensate for structural deflation from removing peg from the base.
 *  Lowered another 5pts in v5.1 to fix C-range overcrowding after
 *  blacklist/decentralization scoring adjustments. */
export const GRADE_THRESHOLDS: { grade: ReportCardGrade; min: number }[] = [
  { grade: "A+", min: 87 },
  { grade: "A", min: 83 },
  { grade: "A-", min: 80 },
  { grade: "B+", min: 75 },
  { grade: "B", min: 70 },
  { grade: "B-", min: 65 },
  { grade: "C+", min: 60 },
  { grade: "C", min: 55 },
  { grade: "C-", min: 50 },
  { grade: "D", min: 40 },
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

  // No current price data AND no historical depeg events → no peg signal at all
  if (peg.currentDeviationBps === null && peg.eventCount === 0) {
    return { grade: "NR", score: null, detail: "No price data available for peg evaluation" };
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
    return { grade: "NR", score: null, detail: "No DEX liquidity data" };
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

const CHAIN_TIER_SCORE: Record<ChainTier, number> = {
  ethereum: 100,
  "stage1-l2": 66,
  "established-alt-l1": 20,
  unproven: 0,
};

const DEPLOYMENT_MULT: Record<DeploymentModel, number> = {
  "single-chain": 1.0,
  "canonical-bridge": 0.85,
  "third-party-bridge": 0.60,
  "native-multichain": 0.40,
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

const CHAIN_TIER_LABEL: Record<ChainTier, string> = {
  ethereum: "Ethereum mainnet",
  "stage1-l2": "Stage 1+ L2",
  "established-alt-l1": "Established alt-L1",
  unproven: "Unproven chain",
};

const DEPLOYMENT_MODEL_LABEL: Record<DeploymentModel, string> = {
  "single-chain": "",
  "canonical-bridge": "canonical bridge",
  "third-party-bridge": "third-party bridge",
  "native-multichain": "native multichain",
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

/** Combined chain infrastructure score: tier base × deployment multiplier */
export function chainInfraScore(tier: ChainTier, model: DeploymentModel): number {
  return Math.round(CHAIN_TIER_SCORE[tier] * DEPLOYMENT_MULT[model]);
}

/** Two-part label: "Ethereum mainnet (third-party bridge)" */
export function chainInfraLabel(tier: ChainTier, model: DeploymentModel): string {
  const base = CHAIN_TIER_LABEL[tier];
  const suffix = DEPLOYMENT_MODEL_LABEL[model];
  return suffix ? `${base} (${suffix})` : base;
}

/**
 * Infer default resilience sub-factors from backing + governance.
 * Only used when the field is not explicitly set on StablecoinMeta.
 */
export function inferResilienceDefaults(
  backing: BackingType,
  governance: GovernanceType,
): { chainTier: ChainTier; deploymentModel: DeploymentModel; collateralQuality: CollateralQuality; custodyModel: CustodyModel } {
  if (backing === "rwa-backed" && governance === "centralized") {
    return { chainTier: "ethereum", deploymentModel: "single-chain", collateralQuality: "rwa", custodyModel: "institutional" };
  }
  if (backing === "rwa-backed" && governance === "centralized-dependent") {
    return { chainTier: "ethereum", deploymentModel: "single-chain", collateralQuality: "rwa", custodyModel: "institutional" };
  }
  if (backing === "crypto-backed" && governance === "decentralized") {
    return { chainTier: "ethereum", deploymentModel: "single-chain", collateralQuality: "native", custodyModel: "onchain" };
  }
  if (backing === "crypto-backed" && governance === "centralized-dependent") {
    return { chainTier: "ethereum", deploymentModel: "single-chain", collateralQuality: "eth-lst", custodyModel: "onchain" };
  }
  return { chainTier: "ethereum", deploymentModel: "single-chain", collateralQuality: "native", custodyModel: "onchain" };
}

/**
 * Resolve the final resilience sub-factor values for a coin.
 * Explicit overrides on meta take priority; otherwise, infer from backing + governance.
 */
export function resolveResilienceFactors(meta: StablecoinMeta): {
  chainTier: ChainTier;
  deploymentModel: DeploymentModel;
  collateralQuality: CollateralQuality;
  custodyModel: CustodyModel;
} {
  const defaults = inferResilienceDefaults(meta.flags.backing, meta.flags.governance);
  return {
    chainTier: meta.chainTier ?? defaults.chainTier,
    deploymentModel: meta.deploymentModel ?? defaults.deploymentModel,
    collateralQuality: meta.collateralQuality ?? defaults.collateralQuality,
    custodyModel: meta.custodyModel ?? defaults.custodyModel,
  };
}

/**
 * Resilience: 3-factor weighted average.
 *
 * Sub-factors (each 1/3 of the resilience score):
 * 1. Collateral Quality — trust assumptions in backing assets
 * 2. Custody Model — who holds the collateral?
 * 3. Blacklist Capability — can the issuer freeze funds?
 *
 * Chain infrastructure is scored exclusively in the Decentralization
 * dimension to avoid double-counting.
 */
export function scoreResilience(
  meta: StablecoinMeta,
  canBeBlacklisted: boolean | "possible",
): ReportCardDimension {
  const factors = resolveResilienceFactors(meta);
  const blacklistScore = canBeBlacklisted === true ? 33 : canBeBlacklisted === "possible" ? 66 : 100;
  const blacklistLabel = canBeBlacklisted === true ? "Yes" : canBeBlacklisted === "possible" ? "Possible (mutable contract)" : "No";

  const custodyScore = CUSTODY_MODEL_SCORE[factors.custodyModel];

  const hasReserves = meta.reserves && meta.reserves.length > 0;
  const collateralScore = hasReserves
    ? computeCollateralQualityFromReserves(meta.reserves!)
    : COLLATERAL_QUALITY_SCORE[factors.collateralQuality];
  const collateralLabel = hasReserves
    ? collateralScoreLabel(collateralScore)
    : COLLATERAL_QUALITY_LABEL[factors.collateralQuality];

  const score = Math.round(
    (collateralScore + custodyScore + blacklistScore) / 3,
  );

  const parts = [
    `Collateral: ${collateralLabel} (${collateralScore})`,
    `Custody: ${CUSTODY_MODEL_LABEL[factors.custodyModel]} (${custodyScore})`,
    `Blacklist: ${blacklistLabel} (${blacklistScore})`,
  ];

  return { grade: scoreToGrade(score), score, detail: parts.join(". ") };
}

// ---------------------------------------------------------------------------
// Governance quality scoring
// ---------------------------------------------------------------------------

export const GOVERNANCE_QUALITY_SCORE: Record<GovernanceQuality, number> = {
  "immutable-code": 100,
  "dao-governance": 85,
  "multisig": 55,
  "regulated-entity": 40,
  "single-entity": 20,
  "wrapper": 10,
};

const GOVERNANCE_QUALITY_LABEL: Record<GovernanceQuality, string> = {
  "immutable-code": "Immutable code (no governance)",
  "dao-governance": "DAO governance",
  "multisig": "Multisig governance",
  "regulated-entity": "Regulated entity",
  "single-entity": "Single-entity governance",
  "wrapper": "Wrapper (inherits upstream)",
};

function inferGovernanceQuality(governance: GovernanceType): GovernanceQuality {
  switch (governance) {
    case "decentralized": return "dao-governance";
    case "centralized-dependent": return "multisig";
    case "centralized": return "single-entity";
  }
}

export function resolveGovernanceQuality(
  governance: GovernanceType,
  meta?: StablecoinMeta,
): GovernanceQuality {
  if (meta?.governanceQuality) return meta.governanceQuality;
  const base = inferGovernanceQuality(governance);
  // Auto-promote single-entity → regulated-entity when metadata confirms regulation
  if (base === "single-entity" && meta) {
    const j = meta.jurisdiction;
    const p = meta.proofOfReserves;
    if (j?.regulator && j?.license && p?.type === "independent-audit") {
      return "regulated-entity";
    }
  }
  return base;
}

/**
 * Decentralization: governance quality + chain-risk modifier.
 *
 * Governance quality tiers replace the old 3-level GovernanceType scores:
 *   dao-governance 85, multisig 55, single-entity 20, wrapper 10.
 * Chain penalty: protocols on less decentralized chains get a reduction
 * because governance decentralization is undermined when the underlying
 * chain itself has centralisation concerns (validator set, halt risk, etc.).
 */
export function scoreDecentralization(
  governance: GovernanceType,
  meta?: StablecoinMeta,
): ReportCardDimension {
  const quality = resolveGovernanceQuality(governance, meta);
  let score = GOVERNANCE_QUALITY_SCORE[quality];

  // Chain infrastructure penalty (threshold-based on combined score)
  const factors = meta ? resolveResilienceFactors(meta) : undefined;
  const infraScore = factors
    ? chainInfraScore(factors.chainTier, factors.deploymentModel)
    : 100;

  let penalty = 0;
  if (infraScore >= 80) penalty = 0;
  else if (infraScore >= 50) penalty = -15;
  else if (infraScore >= 15) penalty = -50;
  else penalty = -65;

  if (quality !== "immutable-code" && quality !== "single-entity" && quality !== "regulated-entity" && penalty < 0) {
    score = Math.max(0, score + penalty);
  }

  const govScore = GOVERNANCE_QUALITY_SCORE[quality];
  let detail: string;
  if (factors) {
    const chainDesc = chainInfraLabel(factors.chainTier, factors.deploymentModel);
    detail = `Governance: ${GOVERNANCE_QUALITY_LABEL[quality]} (${govScore}). Chain: ${chainDesc} (${penalty})`;
  } else {
    detail = `Governance: ${GOVERNANCE_QUALITY_LABEL[quality]} (${govScore})`;
  }

  return { grade: scoreToGrade(score), score, detail };
}

/**
 * Dependency Risk: universal scoring across all governance tiers.
 * - Coins with no dependencies: 95
 * - Coins with mapped deps: weighted blend of upstream + self-backed scores
 * - Self-backed score varies by governance type (90/75/95)
 * - Coins with deps but scores unavailable: 70
 */

const SELF_BACKED_SCORE_BY_GOVERNANCE: Record<GovernanceType, number> = {
  decentralized: 90,
  "centralized-dependent": 75,
  centralized: 95,
};

export function scoreDependencyRisk(
  meta: StablecoinMeta,
  overallScores: Map<string, number>,
): ReportCardDimension {
  const deps = deriveDependencies(meta);
  if (!deps || deps.length === 0) {
    return { grade: scoreToGrade(95), score: 95, detail: "Not dependent on upstream stablecoins" };
  }

  // Gather upstream scores with weights
  const resolved: { id: string; weight: number; score: number; type: DependencyType }[] = [];
  for (const dep of deps) {
    const s = overallScores.get(dep.id);
    if (s !== undefined) resolved.push({ id: dep.id, weight: dep.weight, score: s, type: dep.type ?? "collateral" });
  }

  if (resolved.length === 0) {
    return { grade: scoreToGrade(70), score: 70, detail: "Upstream dependency scores unavailable" };
  }

  const governance = meta.flags.governance;
  const SELF_BACKED_SCORE = SELF_BACKED_SCORE_BY_GOVERNANCE[governance];
  const rawTotal = resolved.reduce((sum, d) => sum + d.weight, 0);
  const totalWeight = Math.min(1, rawTotal);
  const selfBackedFraction = 1 - totalWeight;
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

  const GOV_LABEL: Record<GovernanceType, string> = {
    decentralized: "Decentralized",
    "centralized-dependent": "Partially centralized",
    centralized: "Centralized",
  };

  const parts: string[] = [];
  parts.push(`Upstream: ${resolved.length} upstream dep${resolved.length === 1 ? "" : "s"} (${Math.round(totalWeight * 100)}% weight) (${Math.round(blendedScore)})`);
  parts.push(`Self-backed: ${GOV_LABEL[governance]} (${SELF_BACKED_SCORE})`);
  if (weakDeps.length > 0) {
    parts.push(`Penalty: ${weakDeps.length} weak dep${weakDeps.length === 1 ? "" : "s"} below 75 (-10)`);
  }
  if (ceiling < Infinity) {
    const ceilingType = resolved.some(d => d.type === "wrapper") ? "wrapper" : "mechanism-critical";
    parts.push(`Ceiling: ${ceilingType} dependency ceiling (${Math.round(ceiling)})`);
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
 * PSI = null + navToken → multiplier 1.0 (NAV token, peg tracking not applicable).
 * PSI = null + non-NAV → overall NR (no price/peg data available).
 * PSI = 0 (dead coin) → multiplier = 0.
 *
 * Requires at least 2 rated base dimensions for an overall grade, else NR.
 */
export function computeOverallGrade(
  dimensions: Record<DimensionKey, ReportCardDimension>,
  opts?: { navToken?: boolean },
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
  } else if (!opts?.navToken) {
    // Non-NAV coin with no peg data → overall NR (can't evaluate peg health)
    return { grade: "NR", score: null, ratedDimensions: baseRatedCount };
  }
  // NAV token with null peg → multiplier 1.0, no change

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
      const overall = computeOverallGrade(newDimensions, { navToken: card.rawInputs.navToken });
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
