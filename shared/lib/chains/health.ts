import type { ChainResilienceTier } from "./index";
import type {
  ChainEnvironmentEvidence,
  ChainHealthFactors,
  ChainPegStabilityCoverage,
  HealthBand,
} from "../../types/chains";
import type { Ratio } from "../../types/ratio";
import { L2BEAT_CHAIN_RISK_SNAPSHOT_META, getL2BeatChainEnvironmentAssessment } from "./l2beat-risk";
import { bandFromThresholds, hhiToDiversityScore } from "../math";
import { deriveDepegSignal } from "../depeg-signals";

export { CHAIN_HEALTH_METHODOLOGY_VERSION as HEALTH_METHODOLOGY_VERSION } from "../methodology-versions/constants";

export const QUALITY_WEIGHT = 0.30;
export const CHAIN_ENVIRONMENT_WEIGHT = 0.20;
export const CONCENTRATION_WEIGHT = 0.20;
export const PEG_STABILITY_WEIGHT = 0.20;
export const BACKING_DIVERSITY_WEIGHT = 0.10;

const QUALITY_COVERAGE_THRESHOLD = 0.5;
const PEG_DEVIATION_SCORE_DIVISOR_BPS = 5;
const ROBUST_HEALTH_BAND_MIN = 80;
const HEALTHY_HEALTH_BAND_MIN = 60;
const MIXED_HEALTH_BAND_MIN = 40;
const FRAGILE_HEALTH_BAND_MIN = 20;

/** Chain environment scores by resilience tier. */
export const CHAIN_ENVIRONMENT_SCORES: Record<ChainResilienceTier, number> = {
  1: 100,  // Battle-tested, highly decentralized (Ethereum)
  2: 60,   // Established chains with some centralization
  3: 20,   // Unproven or problematic chains
};

// --- Sub-factor computations ---

/** Concentration: 100 * (1 - HHI). Single coin = 0, even N-way split = 100*(1-1/N). */
export function computeConcentrationScore(shares: number[]): number {
  if (shares.length <= 1) return 0;
  const hhi = shares.reduce((sum, s) => sum + s * s, 0);
  return Math.round(hhiToDiversityScore(hhi));
}

export const ACTIVE_BACKING_DIVERSITY_TYPES = ["rwa-backed", "crypto-backed"] as const;

/** Backing diversity: normalized Shannon entropy across the active RWA/crypto backing split. */
export function computeBackingDiversityScore(
  distribution: Record<string, number>,
): number {
  const values = ACTIVE_BACKING_DIVERSITY_TYPES
    .map((type) => distribution[type] ?? 0)
    .filter((value) => value > 0);
  if (values.length <= 1) return 0;

  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return 0;

  const normalizedValues = values.map((value) => value / total);
  const entropy = -normalizedValues.reduce((sum, share) => sum + share * Math.log(share), 0);
  const maxEntropy = Math.log(ACTIVE_BACKING_DIVERSITY_TYPES.length);
  return Math.round(100 * (entropy / maxEntropy));
}

function pegProximityScore(price: number | null, pegRef: number): number | null {
  const signal = price == null ? null : deriveDepegSignal(price, pegRef);
  // `absRawBps` is the unrounded deviation, matching the previous inline formula.
  return signal == null ? null : Math.max(0, 100 - (signal.absRawBps ?? signal.absBps) / PEG_DEVIATION_SCORE_DIVISOR_BPS);
}

export interface PegStabilityCandidate {
  price: number | null;
  /** `null` when the coin's peg has no reference rate; the coin still counts in the coverage denominator. */
  pegRef: number | null;
  supplyUsd: number;
}

export interface PegStabilityAssessment {
  /** Observed-only peg proximity; null when no positive supply has usable peg evidence. */
  score: number | null;
  coverage: ChainPegStabilityCoverage;
}

/**
 * Peg stability plus its observation coverage against the chain's full positive supply. A coin is observed
 * only when it has a usable price and a usable (finite, positive) peg reference; coins lacking a reference
 * stay in the denominator so missing-reference supply cannot inflate coverage.
 */
export function assessPegStability(coins: readonly PegStabilityCandidate[]): PegStabilityAssessment {
  let eligibleSupplyUsd = 0;
  let observedSupplyUsd = 0;
  let noUsablePriceSupplyUsd = 0;
  let noPegReferenceSupplyUsd = 0;
  let observedWeightedSum = 0;
  let observedCount = 0;
  let unobservedCount = 0;
  for (const coin of coins) {
    if (!(coin.supplyUsd > 0)) continue;
    eligibleSupplyUsd += coin.supplyUsd;
    const coinScore = coin.pegRef == null ? null : pegProximityScore(coin.price, coin.pegRef);
    if (coinScore != null) {
      observedCount += 1;
      observedSupplyUsd += coin.supplyUsd;
      observedWeightedSum += coinScore * coin.supplyUsd;
      continue;
    }
    unobservedCount += 1;
    if (coin.pegRef == null || !Number.isFinite(coin.pegRef) || coin.pegRef <= 0) {
      noPegReferenceSupplyUsd += coin.supplyUsd;
    } else {
      noUsablePriceSupplyUsd += coin.supplyUsd;
    }
  }

  const observedScore = observedCount === 0 ? null : Math.round(observedWeightedSum / observedSupplyUsd);
  return {
    score: observedScore,
    coverage: {
      status: observedCount === 0 ? "unavailable" : unobservedCount > 0 ? "partial" : "complete",
      observedSupplyUsd,
      eligibleSupplyUsd,
      coverage: (eligibleSupplyUsd > 0 ? observedSupplyUsd / eligibleSupplyUsd : 0) as Ratio,
      noUsablePriceSupplyUsd,
      noPegReferenceSupplyUsd,
      // Retained for interpreting cached pre-v1.6 payloads; new scores never impute evidence.
      neutralImputedSupplyUsd: 0,
      observedScore,
    },
  };
}

interface QualityCoin {
  safetyScore: number | null;
  supplyUsd: number;
}

/**
 * Quality: supply-weighted average of safety scores over *rated* supply only.
 *
 * Not-rated (NR) supply is excluded from both the numerator and the denominator
 * rather than imputed a score. Imputing a value would assert a risk judgement
 * Pharos has not made; the coverage gate below is what carries the "we do not
 * know enough about this chain" signal — under 50% rated supply the factor is
 * `null`, which nulls the whole composite.
 */
export function computeQualityScore(
  coins: QualityCoin[],
): number | null {
  let totalSupply = 0;
  let ratedSupply = 0;
  let weightedSum = 0;
  for (const coin of coins) {
    totalSupply += coin.supplyUsd;
    if (coin.safetyScore == null) continue;
    ratedSupply += coin.supplyUsd;
    weightedSum += coin.safetyScore * coin.supplyUsd;
  }
  if (totalSupply === 0) return null;
  if (ratedSupply / totalSupply < QUALITY_COVERAGE_THRESHOLD) return null;

  return Math.round(weightedSum / ratedSupply);
}

/** Chain environment evidence: uses L2BEAT matched-chain risk first, then falls back to the resilience tier. */
export function computeChainEnvironmentAssessment(
  tier: ChainResilienceTier,
  chainId?: string,
): ChainEnvironmentEvidence {
  if (chainId) {
    const l2beat = getL2BeatChainEnvironmentAssessment(chainId);
    if (l2beat) {
      return {
        source: "l2beat",
        score: l2beat.score,
        projectId: l2beat.projectId,
        slug: l2beat.slug,
        name: l2beat.name,
        stage: l2beat.stage,
        isUnderReview: l2beat.isUnderReview,
        stageScore: l2beat.stageScore,
        riskScore: l2beat.riskScore,
        risks: l2beat.risks,
        snapshot: {
          source: L2BEAT_CHAIN_RISK_SNAPSHOT_META.source,
          fetchedAt: L2BEAT_CHAIN_RISK_SNAPSHOT_META.fetchedAt,
        },
      };
    }
  }
  return {
    source: "pharos-chain-tier",
    score: CHAIN_ENVIRONMENT_SCORES[tier],
    resilienceTier: tier,
  };
}


// --- Composite ---

/**
 * Composite Chain Health requires sufficient rated supply and complete peg coverage.
 * Partial peg factors remain visible, but no partial-coverage composite threshold is approved.
 */
export function computeHealthScore(
  factors: ChainHealthFactors,
  pegCoverageStatus: ChainPegStabilityCoverage["status"],
): number | null {
  if (factors.quality == null || factors.pegStability == null || pegCoverageStatus !== "complete") return null;
  const raw =
    QUALITY_WEIGHT * factors.quality +
    CHAIN_ENVIRONMENT_WEIGHT * factors.chainEnvironment +
    CONCENTRATION_WEIGHT * factors.concentration +
    PEG_STABILITY_WEIGHT * factors.pegStability +
    BACKING_DIVERSITY_WEIGHT * factors.backingDiversity;
  return Math.round(raw);
}

const HEALTH_BANDS: readonly { min: number; band: HealthBand }[] = [
  { min: ROBUST_HEALTH_BAND_MIN, band: "robust" },
  { min: HEALTHY_HEALTH_BAND_MIN, band: "healthy" },
  { min: MIXED_HEALTH_BAND_MIN, band: "mixed" },
  { min: FRAGILE_HEALTH_BAND_MIN, band: "fragile" },
];

const CONCENTRATED_HEALTH_BAND = { min: Number.NEGATIVE_INFINITY, band: "concentrated" } as const;

export function getHealthBand(score: number | null): HealthBand | null {
  if (score == null) return null;
  return bandFromThresholds(score, HEALTH_BANDS, CONCENTRATED_HEALTH_BAND).band;
}
