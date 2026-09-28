/**
 * Mint/Burn flow scoring — pure functions for Flow Intensity Score (FIS),
 * Bank Run Gauge composite, and flight-to-quality detection.
 *
 * Runtime-neutral shared helper imports only; designed for easy unit testing.
 */

import { clamp } from "@shared/lib/math";
import { mintBurnSignedNetRange } from "@shared/lib/mint-burn-valuation";
import type { MintBurnValuation } from "@shared/types/mint-burn";

// ---------------------------------------------------------------------------
// Flow Intensity Score (FIS)
// ---------------------------------------------------------------------------

export interface FlowIntensityInput {
  /** Current 24 h net flow (mint − burn), USD */
  currentDailyNet: number;
  /** 30-day rolling average net flow, USD */
  baselineDailyNet: number;
  /** 30-day rolling average absolute flow (|mint| + |burn|), USD */
  baselineDailyAbs: number;
  /** How many days of flow history we have */
  dataAgeDays: number;
  /** Current 24 h absolute flow (|mint| + |burn|), USD — used for activity gate */
  currentDailyAbs: number;
}

// Calibrated so the denominator approximates a normal ~30% daily swing in baseline absolute flow.
const FLOW_INTENSITY_DENOMINATOR_SCALE = 0.3;
const FLOW_INTENSITY_DENOMINATOR_FLOOR_USD = 1_000_000;
// Calibrated so z ≈ 2 (a ~2σ flow move) maps to the ±100 score bound.
const FLOW_INTENSITY_Z_MULTIPLIER = 50;
/** Minimum baseline history for a pressure score; a shorter baseline is NR regardless of valuation. */
export const FLOW_INTENSITY_MIN_DATA_DAYS = 7;
const FLOW_INTENSITY_MIN = -100;
const FLOW_INTENSITY_MAX = 100;
const MIN_ACTIVITY_USD = 50_000;

/**
 * Compute the Flow Intensity Score for a single stablecoin.
 *
 * Formula:
 *   denominator = max(baselineDailyAbs * 0.3, 1_000_000)
 *   z = (currentDailyNet − baselineDailyNet) / denominator
 *   intensity = clamp(-100, 100, z * 50)   (see FLOW_INTENSITY_* constants for authoritative values)
 *
 * Returns `null` when 24h absolute flow is below MIN_ACTIVITY_USD,
 * or when we have fewer than 7 days of data.
 */
export function computeFlowIntensity(
  input: FlowIntensityInput
): number | null {
  if (input.currentDailyAbs < MIN_ACTIVITY_USD) return null;
  if (input.dataAgeDays < FLOW_INTENSITY_MIN_DATA_DAYS) return null;

  const denominator = Math.max(
    input.baselineDailyAbs * FLOW_INTENSITY_DENOMINATOR_SCALE,
    FLOW_INTENSITY_DENOMINATOR_FLOOR_USD
  );
  const z = (input.currentDailyNet - input.baselineDailyNet) / denominator;
  const raw = z * FLOW_INTENSITY_Z_MULTIPLIER;
  // Aggregate callers pass finite SQL/Zod-normalized values; clamp is the signed score range guard.
  return clamp(raw, FLOW_INTENSITY_MIN, FLOW_INTENSITY_MAX);
}

// ---------------------------------------------------------------------------
// Gauge bands
// ---------------------------------------------------------------------------

/** Exhaustive union of gauge-band labels returned by {@link getGaugeBand}. */
export type GaugeBand = "CRISIS" | "STRESS" | "CAUTIOUS" | "NEUTRAL" | "HEALTHY" | "CONFIDENT" | "SURGE";

/**
 * Return the band label for the band that contains `score`.
 * Boundary convention: each band is [min, max).  The last band includes 100.
 *
 * NaN/out-of-range returns "NEUTRAL" as a sentinel — intrinsic to the design
 * and documented here; callers do not need to handle it separately.
 */
export function getGaugeBand(score: number): GaugeBand {
  // Score-visible [min, max) assignments; boundary tests pin these labels.
  // Out-of-range/NaN sentinel (distinct from the real [-10,10) NEUTRAL band below);
  // unreachable for mcap-weighted intensity inputs, which are already clamped to [-100,100].
  if (Number.isNaN(score) || score < -100) return "NEUTRAL";
  if (score < -70) return "CRISIS";
  if (score < -40) return "STRESS";
  if (score < -10) return "CAUTIOUS";
  if (score < 10) return "NEUTRAL";
  if (score < 40) return "HEALTHY";
  if (score < 70) return "CONFIDENT";
  return "SURGE";
}

// ---------------------------------------------------------------------------
// Bank Run Gauge (market-cap-weighted composite)
// ---------------------------------------------------------------------------

export interface GaugeCoinInput {
  intensity: number | null;
  mcap: number;
}

/**
 * Compute the market-cap-weighted average Flow Intensity Score across coins.
 * Skips coins with null intensity (insufficient data) and computes from available data.
 * Returns `null` only when no coin has valid intensity data.
 */
export function computeGaugeScore(
  coins: GaugeCoinInput[]
): number | null {
  let totalMcap = 0;
  let weightedSum = 0;

  for (const coin of coins) {
    if (coin.intensity === null) continue;
    totalMcap += coin.mcap;
    weightedSum += coin.intensity * coin.mcap;
  }

  if (totalMcap === 0) return null;
  return weightedSum / totalMcap;
}

/**
 * Whether the published gauge band is independent of weight withheld from it.
 * `computeGaugeScore` re-weights over the scored weight `W`; a withheld coin
 * of weight `w` has an unknown true intensity `x` in [-100, 100] (or none),
 * so the full-cohort score lies in [(W·S − 100w)/(W+w), (W·S + 100w)/(W+w)].
 * The band is robust only when both ends fall in the band of `S` (bands are
 * contiguous, so the whole interval does). The implied shift is at most
 * w/(W+w)·(100 + |S|).
 */
export function isGaugeBandRobustToWithheldWeight(input: {
  score: number;
  scoredMcapUsd: number;
  withheldMcapUsd: number;
}): boolean {
  const { score, scoredMcapUsd, withheldMcapUsd } = input;
  if (withheldMcapUsd <= 0) return true;
  if (!(scoredMcapUsd > 0)) return false;
  const total = scoredMcapUsd + withheldMcapUsd;
  // Clamp away floating-point overshoot past the score range (getGaugeBand's out-of-range sentinel).
  const lower = clamp((scoredMcapUsd * score + FLOW_INTENSITY_MIN * withheldMcapUsd) / total, FLOW_INTENSITY_MIN, FLOW_INTENSITY_MAX);
  const upper = clamp((scoredMcapUsd * score + FLOW_INTENSITY_MAX * withheldMcapUsd) / total, FLOW_INTENSITY_MIN, FLOW_INTENSITY_MAX);
  const band = getGaugeBand(score);
  return getGaugeBand(lower) === band && getGaugeBand(upper) === band;
}

// ---------------------------------------------------------------------------
// Flight-to-quality detection
// ---------------------------------------------------------------------------

export interface FlightToQualityInput {
  /** 24 h net flow of "safe" stablecoins (USDC, USDT, etc.), USD */
  safeNet24h: number;
  /** 24 h net flow of "risky" stablecoins, USD (negative = outflows) */
  riskyNet24h: number;
}

export interface FlightToQualityResult {
  active: boolean;
  intensity: number;
}

const FLIGHT_TO_QUALITY_FLOW_THRESHOLD_USD = 100_000_000;
const FLIGHT_TO_QUALITY_FULL_INTENSITY_USD = 1_000_000_000;

/**
 * Detect flight-to-quality: risky stablecoins losing supply while safe ones
 * gain simultaneously.
 *
 * Active when riskyNet24h < -$100 M AND safeNet24h > +$100 M.
 * Intensity = min(100, |riskyNet24h| / $1 B * 100).
 */
export function detectFlightToQuality(
  input: FlightToQualityInput
): FlightToQualityResult {
  const active =
    input.riskyNet24h < -FLIGHT_TO_QUALITY_FLOW_THRESHOLD_USD
    && input.safeNet24h > FLIGHT_TO_QUALITY_FLOW_THRESHOLD_USD;

  if (!active) return { active: false, intensity: 0 };

  const intensity = Math.min(
    100,
    (Math.abs(input.riskyNet24h) / FLIGHT_TO_QUALITY_FULL_INTENSITY_USD) * 100,
  );
  return { active: true, intensity };
}

export interface ValuedNetFlow24h {
  /** Known-valuation 24h net; `null` when unpublished (treated as fully unbounded). */
  knownNetUsd: number | null;
  valuation: Pick<MintBurnValuation, "mintCompleteness" | "burnCompleteness">;
}

/**
 * Flight-to-quality over per-coin nets that may lack valuation. Exact when every
 * classified coin's 24h valuation is complete. Otherwise only a proven-inactive
 * decision survives: the proven net ranges already rule activation out. Any other
 * case returns `null` (unavailable) because missing valuation can alter it.
 * The returned nets are known-valuation sums; they are exact only when `exact`.
 */
export function detectFlightToQualityFromValuedNets(input: {
  safe: readonly ValuedNetFlow24h[];
  risky: readonly ValuedNetFlow24h[];
}): (FlightToQualityResult & { safeNet24h: number; riskyNet24h: number; exact: boolean }) | null {
  const sum = (coins: readonly ValuedNetFlow24h[]) => {
    let knownUsd = 0;
    let lowerUsd = 0;
    let upperUsd = 0;
    for (const coin of coins) {
      if (coin.knownNetUsd === null) {
        lowerUsd = Number.NEGATIVE_INFINITY;
        upperUsd = Number.POSITIVE_INFINITY;
        continue;
      }
      const range = mintBurnSignedNetRange(coin.knownNetUsd, coin.valuation);
      knownUsd += coin.knownNetUsd;
      lowerUsd += range.lowerUsd;
      upperUsd += range.upperUsd;
    }
    return { knownUsd, lowerUsd, upperUsd, exact: lowerUsd === upperUsd };
  };
  const safe = sum(input.safe);
  const risky = sum(input.risky);
  if (safe.exact && risky.exact) {
    return {
      ...detectFlightToQuality({ safeNet24h: safe.knownUsd, riskyNet24h: risky.knownUsd }),
      safeNet24h: safe.knownUsd,
      riskyNet24h: risky.knownUsd,
      exact: true,
    };
  }
  const provenInactive = risky.lowerUsd >= -FLIGHT_TO_QUALITY_FLOW_THRESHOLD_USD
    || safe.upperUsd <= FLIGHT_TO_QUALITY_FLOW_THRESHOLD_USD;
  return provenInactive
    ? { active: false, intensity: 0, safeNet24h: safe.knownUsd, riskyNet24h: risky.knownUsd, exact: false }
    : null;
}
