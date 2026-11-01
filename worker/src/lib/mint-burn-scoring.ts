/**
 * Mint/Burn flow scoring — pure functions for Flow Intensity Score (FIS),
 * Bank Run Gauge composite, and flight-to-quality detection.
 *
 * Runtime-neutral shared helper imports only; designed for easy unit testing.
 */

import { clamp } from "@shared/lib/math";
import { mintBurnSignedNetRange } from "@shared/lib/mint-burn-valuation";
import { PRESSURE_SHIFT_MIN_BASELINE_DAYS } from "@shared/lib/mint-burn-signals";
import type {
  MintBurnFtqUnavailableReason,
  MintBurnPublication,
  MintBurnValuation,
} from "@shared/types/mint-burn";

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
export const FLOW_INTENSITY_MIN_DATA_DAYS = PRESSURE_SHIFT_MIN_BASELINE_DAYS;
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

// Thresholds live in shared/lib so the frontend draws the same band zones (R5).
export {
  getGaugeBand,
  getGaugeScoreInterval,
  isGaugeBandRobustToWithheldWeight,
} from "@shared/lib/mint-burn-gauge-bands";

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
 * Returns `null` when no coin with valid intensity has a positive market-cap weight.
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
  // The mean of bounded inputs is in the domain; only float dust can leave it.
  // Keep the published composite on the documented [-100, 100] interval.
  return clamp(weightedSum / totalMcap, -100, 100);
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
  /**
   * Whether the published 24h flow window itself is complete. `null`/absent when
   * the publication carries no window evidence (legacy payload).
   */
  window24hComplete?: boolean | null;
}

/** The published leg statuses that decide whether a classified coin's flow is in scope. */
export type FlightToQualityPublicationScope = {
  legs: ReadonlyArray<Pick<MintBurnPublication["legs"][number], "stablecoinId" | "status">>;
};

export interface FlightToQualityCohorts {
  safe: ValuedNetFlow24h[];
  risky: ValuedNetFlow24h[];
  /** Classified coins excluded because their whole flow is pending mint/burn admission. */
  excludedIds: string[];
  /** Classified coins still carried as unbounded members because they have no published flow. */
  unpublishedIds: string[];
}

/**
 * Builds the safe/risky cohorts over the classified roster. A classified coin whose
 * whole flow is pending mint/burn admission is outside the published flow scope: it
 * is excluded and its id disclosed, never published as a measured zero. Any other
 * classified coin with no published 24h net (kill switch, missing flow row) is
 * carried as an unbounded member; dropping it would let the omitted flow prove an
 * inactivity it cannot support (R1/R2).
 */
export function buildFlightToQualityCohorts(
  classification: { safeIds: ReadonlySet<string>; riskyIds: ReadonlySet<string> },
  flowsById: ReadonlyMap<string, ValuedNetFlow24h>,
  publication?: FlightToQualityPublicationScope | null,
): FlightToQualityCohorts {
  const pendingAdmissionIds = new Set<string>();
  for (const leg of publication?.legs ?? []) {
    if (leg.status === "pending-admission" && !flowsById.has(leg.stablecoinId)) {
      pendingAdmissionIds.add(leg.stablecoinId);
    }
  }
  const unbounded = (): ValuedNetFlow24h => ({
    knownNetUsd: null,
    valuation: { mintCompleteness: "unknown", burnCompleteness: "unknown" },
    window24hComplete: null,
  });
  const excludedIds: string[] = [];
  const unpublishedIds: string[] = [];
  const cohort = (ids: ReadonlySet<string>) => [...ids].flatMap((id) => {
    const flow = flowsById.get(id);
    if (flow) return [flow];
    if (pendingAdmissionIds.has(id)) {
      excludedIds.push(id);
      return [];
    }
    unpublishedIds.push(id);
    return [unbounded()];
  });
  const cohorts = { safe: cohort(classification.safeIds), risky: cohort(classification.riskyIds) };
  return { ...cohorts, excludedIds: excludedIds.sort(), unpublishedIds: unpublishedIds.sort() };
}

/**
 * Names why the detector withheld a verdict (R4). A structural absence wins over
 * scan completeness, which wins over valuation, so the published reason never
 * claims valuation for a coin the flow scope could not publish at all.
 */
export function getFlightToQualityUnavailableReason(
  cohorts: Pick<FlightToQualityCohorts, "safe" | "risky" | "unpublishedIds">,
): MintBurnFtqUnavailableReason {
  if (cohorts.unpublishedIds.length > 0) return "cohort-member-unpublished";
  const windowIncomplete = [...cohorts.safe, ...cohorts.risky]
    .some((coin) => coin.knownNetUsd === null && coin.window24hComplete !== true);
  return windowIncomplete ? "flow-window-unavailable" : "valuation-incomplete";
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
