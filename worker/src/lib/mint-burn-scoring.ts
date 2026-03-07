/**
 * Mint/Burn flow scoring — pure functions for Flow Intensity Score (FIS),
 * Bank Run Gauge composite, and flight-to-quality detection.
 *
 * No external dependencies; designed for easy unit testing.
 */

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
}

const DENOM_SCALE = 0.3;
const DENOM_FLOOR = 1_000_000; // $1 M minimum denominator
const Z_MULTIPLIER = 50;
const MIN_DATA_DAYS = 7;

/**
 * Compute the Flow Intensity Score for a single stablecoin.
 *
 * Formula:
 *   denominator = max(baselineDailyAbs * 0.3, 1_000_000)
 *   z = (currentDailyNet − baselineDailyNet) / denominator
 *   intensity = clamp(-100, 100, z * 50)
 *
 * Returns `null` when we have fewer than 7 days of data.
 */
export function computeFlowIntensity(
  input: FlowIntensityInput
): number | null {
  if (input.dataAgeDays < MIN_DATA_DAYS) return null;

  const denominator = Math.max(
    input.baselineDailyAbs * DENOM_SCALE,
    DENOM_FLOOR
  );
  const z = (input.currentDailyNet - input.baselineDailyNet) / denominator;
  const raw = z * Z_MULTIPLIER;
  return Math.max(-100, Math.min(100, raw));
}

// ---------------------------------------------------------------------------
// Gauge bands
// ---------------------------------------------------------------------------

export interface GaugeBand {
  min: number;
  max: number;
  label: string;
  color: string;
}

const GAUGE_BANDS: GaugeBand[] = [
  { min: -100, max: -70, label: "CRISIS", color: "red" },
  { min: -70, max: -40, label: "STRESS", color: "orange" },
  { min: -40, max: -10, label: "CAUTIOUS", color: "amber" },
  { min: -10, max: 10, label: "NEUTRAL", color: "gray" },
  { min: 10, max: 40, label: "HEALTHY", color: "light-green" },
  { min: 40, max: 70, label: "CONFIDENT", color: "green" },
  { min: 70, max: 100, label: "SURGE", color: "bright-green" },
];

/**
 * Return the `{ label, color }` for the band that contains `score`.
 * Boundary convention: each band is [min, max).  The last band includes 100.
 */
export function getGaugeBand(
  score: number
): { label: string; color: string } {
  for (const band of GAUGE_BANDS) {
    if (score >= band.min && (score < band.max || band.max === 100)) {
      return { label: band.label, color: band.color };
    }
  }
  // Fallback — should never happen with -100..100 input
  return { label: "NEUTRAL", color: "gray" };
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

const FTQ_THRESHOLD = 1e8; // $100 M

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
    input.riskyNet24h < -FTQ_THRESHOLD && input.safeNet24h > FTQ_THRESHOLD;

  if (!active) return { active: false, intensity: 0 };

  const intensity = Math.min(100, (Math.abs(input.riskyNet24h) / 1e9) * 100);
  return { active: true, intensity };
}
