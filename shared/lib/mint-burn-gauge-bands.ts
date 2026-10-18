import { clamp } from "./math";

/**
 * Bank Run Gauge bands: the single threshold authority (R5) shared by the
 * Worker producer that publishes `gauge.band` and the frontend surfaces that
 * draw band zones (the /flows/ run line).
 */

/** Exhaustive union of gauge-band labels returned by {@link getGaugeBand}. */
export type GaugeBand = "CRISIS" | "STRESS" | "CAUTIOUS" | "NEUTRAL" | "HEALTHY" | "CONFIDENT" | "SURGE";

/** Bands in score order with their [min, max) bounds; the last band includes 100. */
export const GAUGE_BAND_RANGES: readonly { band: GaugeBand; min: number; max: number }[] = [
  { band: "CRISIS", min: -100, max: -70 },
  { band: "STRESS", min: -70, max: -40 },
  { band: "CAUTIOUS", min: -40, max: -10 },
  { band: "NEUTRAL", min: -10, max: 10 },
  { band: "HEALTHY", min: 10, max: 40 },
  { band: "CONFIDENT", min: 40, max: 70 },
  { band: "SURGE", min: 70, max: 100 },
];

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
  for (const range of GAUGE_BAND_RANGES) {
    if (score < range.max) return range.band;
  }
  return "SURGE";
}

const GAUGE_SCORE_MIN = -100;
const GAUGE_SCORE_MAX = 100;

/** Full-cohort bounds for an unknown withheld intensity in [-100, 100]. */
export function getGaugeScoreInterval(input: {
  score: number;
  scoredMcapUsd: number;
  withheldMcapUsd: number;
}): readonly [number, number] | null {
  const { score, scoredMcapUsd, withheldMcapUsd } = input;
  if (![score, scoredMcapUsd, withheldMcapUsd].every(Number.isFinite)
      || score < GAUGE_SCORE_MIN || score > GAUGE_SCORE_MAX
      || !(scoredMcapUsd > 0) || withheldMcapUsd < 0) return null;
  const total = scoredMcapUsd + withheldMcapUsd;
  if (!Number.isFinite(total)) return null;
  const scoredFraction = scoredMcapUsd / total;
  const withheldFraction = withheldMcapUsd / total;
  return [
    clamp(scoredFraction * score + GAUGE_SCORE_MIN * withheldFraction, GAUGE_SCORE_MIN, GAUGE_SCORE_MAX),
    clamp(scoredFraction * score + GAUGE_SCORE_MAX * withheldFraction, GAUGE_SCORE_MIN, GAUGE_SCORE_MAX),
  ];
}

/**
 * Whether the published gauge band is independent of weight withheld from it.
 * The producer re-weights over the scored weight `W`; a withheld coin of
 * weight `w` has an unknown true intensity `x` in [-100, 100] (or none), so the
 * full-cohort score lies in [(W·S − 100w)/(W+w), (W·S + 100w)/(W+w)]. The band
 * is robust only when both ends fall in the band of `S` (bands are contiguous,
 * so the whole interval does). The implied shift is at most w/(W+w)·(100 + |S|).
 */
export function isGaugeBandRobustToWithheldWeight(input: {
  score: number;
  scoredMcapUsd: number;
  withheldMcapUsd: number;
}): boolean {
  const interval = getGaugeScoreInterval(input);
  if (!interval) return false;
  const [lower, upper] = interval;
  const band = getGaugeBand(input.score);
  return getGaugeBand(lower) === band && getGaugeBand(upper) === band;
}

/**
 * Whether a consumer may print the published band (the one authority the
 * daily digest, the /flows/ hero and the share card share). With no weighted
 * coin withheld for valuation the band stands. With some withheld, it stands
 * only when every possible full-cohort score keeps it; a withheld count
 * without published weights is unbounded, so the band is unsettled. A payload
 * predating the count (absent) carries no withheld-weight claim.
 */
export function assessGaugeBandSettlement(gauge: {
  score: number | null;
  partialValuationInputs?: number | null;
  scoredMcapUsd?: number | null;
  partialValuationMcapUsd?: number | null;
}): { settled: boolean; interval: readonly [number, number] | null } {
  if (gauge.score == null) return { settled: false, interval: null };
  if (!gauge.partialValuationInputs) return { settled: true, interval: null };
  if (gauge.scoredMcapUsd == null || gauge.partialValuationMcapUsd == null) return { settled: false, interval: null };
  const input = { score: gauge.score, scoredMcapUsd: gauge.scoredMcapUsd, withheldMcapUsd: gauge.partialValuationMcapUsd };
  return { settled: isGaugeBandRobustToWithheldWeight(input), interval: getGaugeScoreInterval(input) };
}
