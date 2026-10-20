import type { MintBurnCoinFlow, MintBurnGauge } from "@shared/types";
import { assessGaugeBandSettlement, type GaugeBand } from "@shared/lib/mint-burn-gauge-bands";
import { inferHas24hActivity, resolvePressureScore } from "@shared/lib/mint-burn-coin-helpers";
import { resolveMintBurnValuation } from "@shared/lib/mint-burn-valuation";
import { PRESSURE_SHIFT_MIN_BASELINE_DAYS, resolvePublishedGaugeBand } from "@shared/lib/mint-burn-signals";

/** Why a tracked coin does not move the gauge this window (machine codes, R4). */
export type RunLineExclusionReason =
  /** Pressure withheld: the 24h window is not fully valued or the baseline is partial (counted in `gauge.partialValuationInputs`). */
  | "valuation-partial"
  /** Missing scan evidence cannot establish activity or quiet. */
  | "activity-unknown"
  /** No mint or burn event in the 24h window. */
  | "no-24h-activity"
  /** Active, but under the history or activity floor (7 days, $50K of 24h flow). */
  | "below-scoring-floor"
  /** Scored, but its supply weight is unavailable, so the gauge excludes it. */
  | "weight-unavailable";

/** Plain-language labels for the exclusion codes (run-line table, per-coin table NR cells). */
export const RUN_LINE_EXCLUSION_LABELS: Record<RunLineExclusionReason, string> = {
  "valuation-partial": "Withheld: partial valuation",
  "activity-unknown": "24h activity unknown",
  "no-24h-activity": "No 24h mint or burn",
  "below-scoring-floor": "Under history or activity floor",
  "weight-unavailable": "Weight unavailable",
};

export interface RunLineTick {
  id: string;
  symbol: string;
  /** Published pressure shift, -100..+100. */
  score: number;
  /** Gauge weight in USD; `null` when the payload predates per-coin weights. */
  weightUsd: number | null;
  /** Gauge points this coin contributes (score × weight ÷ scored weight); `null` without weights. */
  pullPoints: number | null;
}

export interface RunLineStub {
  id: string;
  symbol: string;
  reason: RunLineExclusionReason;
  /** Weight the coin would carry; `null` when unknown or unavailable. */
  weightUsd: number | null;
}

export interface RunLineModel {
  score: number | null;
  /** The published band, only while withheld weight cannot move it; otherwise `null` (see `bandUnsettled`). */
  band: GaugeBand | null;
  /** A score exists, but weight withheld for valuation could carry it across a band edge. */
  bandUnsettled: boolean;
  /** Full-cohort score bounds under the withheld weight; `null` when nothing is withheld or the weights are unpublished. */
  scoreInterval: readonly [number, number] | null;
  /** Coins whose pressure entered the score, in score order. */
  ticks: RunLineTick[];
  /** Tracked coins outside the score, heaviest first. */
  stubs: RunLineStub[];
  /** Every coin carries a published weight, so tick height encodes it. */
  weightsPublished: boolean;
  /** Largest weight drawn (scored or not); the height scale's ceiling. */
  maxWeightUsd: number | null;
  /** Weighted coins withheld for valuation (`gauge.partialValuationInputs`). */
  withheldForValuation: number;
}

/**
 * Mirrors the producer's order (`buildCoinSummaries`): a coin counts as
 * withheld for valuation only when it has 24h activity and enough baseline
 * history to score at all, so the stub count matches `partialValuationInputs`.
 */
export function resolveRunLineExclusionReason(coin: MintBurnCoinFlow): RunLineExclusionReason {
  const activity = inferHas24hActivity(coin);
  if (activity === null) return "activity-unknown";
  if (!activity) return "no-24h-activity";
  if (coin.baselineDataDays == null || coin.baselineDataDays < PRESSURE_SHIFT_MIN_BASELINE_DAYS) return "below-scoring-floor";
  const valuationAdmitsPressure =
    resolveMintBurnValuation(coin.valuation?.window24h).completeness === "complete" && coin.valuation?.baseline !== "partial";
  return valuationAdmitsPressure ? "below-scoring-floor" : "valuation-partial";
}

/**
 * The run line's data: one tick per coin in the gauge, at its pressure shift,
 * with its published gauge weight; every other tracked coin as a counted stub
 * with a machine-readable reason. Contributions sum to the score, so the strip
 * shows why the gauge sits where it does.
 */
export function buildRunLineModel(gauge: MintBurnGauge | null, coins: readonly MintBurnCoinFlow[]): RunLineModel {
  const score = gauge?.score ?? null;
  const weightsPublished = coins.length > 0 && coins.every((coin) => coin.gaugeWeightUsd !== undefined);
  const ticks: RunLineTick[] = [];
  const stubs: RunLineStub[] = [];

  for (const coin of coins) {
    const pressure = resolvePressureScore(coin);
    const weightUsd = weightsPublished ? (coin.gaugeWeightUsd ?? null) : null;
    if (pressure != null && !(weightsPublished && weightUsd == null)) {
      ticks.push({ id: coin.stablecoinId, symbol: coin.symbol, score: pressure, weightUsd, pullPoints: null });
    } else {
      stubs.push({
        id: coin.stablecoinId,
        symbol: coin.symbol,
        reason: pressure != null ? "weight-unavailable" : resolveRunLineExclusionReason(coin),
        weightUsd,
      });
    }
  }

  // The denominator is the weight the gauge actually scored; derive it from the
  // ticks so contributions always sum to the drawn score.
  const scoredWeightUsd = weightsPublished ? ticks.reduce((sum, tick) => sum + (tick.weightUsd ?? 0), 0) : 0;
  if (scoredWeightUsd > 0) {
    for (const tick of ticks) tick.pullPoints = (tick.score * (tick.weightUsd ?? 0)) / scoredWeightUsd;
  }
  ticks.sort((a, b) => a.score - b.score || a.symbol.localeCompare(b.symbol));
  stubs.sort((a, b) => (b.weightUsd ?? -1) - (a.weightUsd ?? -1) || a.symbol.localeCompare(b.symbol));

  const weights = [...ticks, ...stubs].flatMap((entry) => (entry.weightUsd != null && entry.weightUsd > 0 ? [entry.weightUsd] : []));
  const settlement = assessGaugeBandSettlement(gauge ?? { score: null });
  return {
    score,
    band: settlement.settled ? resolvePublishedGaugeBand(gauge?.band, score) : null,
    bandUnsettled: score != null && !settlement.settled,
    scoreInterval: settlement.interval,
    ticks,
    stubs,
    weightsPublished,
    maxWeightUsd: weights.length > 0 ? Math.max(...weights) : null,
    withheldForValuation: gauge?.partialValuationInputs ?? 0,
  };
}

/** Coins with the largest pull on the gauge, by side; empty without weights. */
export function selectRunLineDrivers(model: RunLineModel): { down: RunLineTick[]; up: RunLineTick[] } {
  const ranked = model.ticks
    .filter((tick) => tick.pullPoints != null && Math.abs(tick.pullPoints) >= 0.5)
    .sort((a, b) => Math.abs(b.pullPoints!) - Math.abs(a.pullPoints!));
  return {
    down: ranked.filter((tick) => tick.pullPoints! < 0).slice(0, 2),
    up: ranked.filter((tick) => tick.pullPoints! > 0).slice(0, 2),
  };
}
