import { clamp } from "./math";
import { GAUGE_BAND_RANGES, getGaugeBand, type GaugeBand } from "./mint-burn-gauge-bands";
import type { NetFlowDirection24h, PressureShiftState } from "../types/mint-burn-signals";
import type { MintBurnValuationCompleteness } from "../types/mint-burn";

export { PRESSURE_SHIFT_STATE_VALUES } from "../types/mint-burn-signals";
export type { NetFlowDirection24h, PressureShiftState } from "../types/mint-burn-signals";

const PRESSURE_SHIFT_STABLE_BAND_MAX = 10;

/** Days of closed baseline history a coin needs before its pressure shift can score (Worker producer and page share it). */
export const PRESSURE_SHIFT_MIN_BASELINE_DAYS = 7;

export function getNetFlowDirection24h(input: { netFlow24hUsd: number; has24hActivity: boolean }): NetFlowDirection24h {
  if (!input.has24hActivity) {
    return "inactive";
  }
  if (input.netFlow24hUsd > 0) {
    return "minting";
  }
  if (input.netFlow24hUsd < 0) {
    return "burning";
  }
  return "flat";
}

export function getPressureShiftState(score: number | null): PressureShiftState {
  if (score === null) {
    return "nr";
  }
  if (score > PRESSURE_SHIFT_STABLE_BAND_MAX) {
    return "improving";
  }
  if (score < -PRESSURE_SHIFT_STABLE_BAND_MAX) {
    return "worsening";
  }
  return "stable";
}

/** Machine-readable reason a literal minting-pressure reading is withheld (NR). */
export type LiteralMintingPressureUnavailableReason = "no-24h-volume" | "valuation-partial" | "valuation-unknown";

export type LiteralMintingPressureReading =
  | { score: number; unavailableReason: null }
  | { score: null; unavailableReason: LiteralMintingPressureUnavailableReason };

/**
 * Literal 24h mint-vs-burn balance on a -100..+100 scale. Since mint-burn-flow
 * v6.27 it is published only when both sides are fully valued: a known-valuation
 * subtotal is a lower bound, and a ratio of two lower bounds is no bound at all,
 * so a reading from either side with unpriced (or unrecorded) events is NR with
 * its reason instead of a "balanced" claim.
 */
export function getLiteralMintingPressureReading(input: {
  mintVolume24hUsd: number;
  burnVolume24hUsd: number;
  mintCompleteness: MintBurnValuationCompleteness;
  burnCompleteness: MintBurnValuationCompleteness;
}): LiteralMintingPressureReading {
  if (input.mintCompleteness === "partial" || input.burnCompleteness === "partial") {
    return { score: null, unavailableReason: "valuation-partial" };
  }
  if (input.mintCompleteness === "unknown" || input.burnCompleteness === "unknown") {
    return { score: null, unavailableReason: "valuation-unknown" };
  }
  const totalFlow24h = input.mintVolume24hUsd + input.burnVolume24hUsd;
  if (totalFlow24h <= 0) {
    return { score: null, unavailableReason: "no-24h-volume" };
  }
  return {
    score: clamp(((input.mintVolume24hUsd - input.burnVolume24hUsd) / totalFlow24h) * 100, -100, 100),
    unavailableReason: null,
  };
}

/**
 * The Bank Run Gauge figure as every surface prints it (page hero, share card):
 * one rounding, an explicit `+` above zero and a typographic minus below it.
 */
export function formatBankRunGaugeScore(score: number): string {
  const rounded = Math.round(score);
  if (rounded > 0) return `+${rounded}`;
  if (rounded < 0) return `−${Math.abs(rounded)}`;
  return "0";
}

/**
 * The gauge's published band as a typed `GaugeBand`; `null` when there is no
 * score. The producer's band is the authority; the shared thresholds only fill a
 * payload whose band is missing or outside the vocabulary.
 */
export function resolvePublishedGaugeBand(band: string | null | undefined, score: number | null): GaugeBand | null {
  if (score == null) return null;
  return GAUGE_BAND_RANGES.find((range) => range.band === band)?.band ?? getGaugeBand(score);
}
