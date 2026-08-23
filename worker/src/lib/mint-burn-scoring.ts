/**
 * Mint/Burn flow scoring — pure functions for Flow Intensity Score (FIS),
 * Bank Run Gauge composite, and flight-to-quality detection.
 *
 * Runtime-neutral shared helper imports only; designed for easy unit testing.
 */

import { clamp } from "@shared/lib/math";

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
const FLOW_INTENSITY_MIN_DATA_DAYS = 7;
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
