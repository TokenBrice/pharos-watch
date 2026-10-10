/**
 * DEWS sub-signal computations — one function per signal family.
 *
 * Each family maps coin-level evidence to a stress score in [0, 100] with an
 * `available` flag plus per-signal debug fields used by the explainability
 * pipeline.
 *
 * Pure functions. All curves and source-quality weights are colocated with the
 * family they belong to so that calibration changes stay local.
 */

import { clamp } from "@shared/lib/math";
import type { YieldRankChangeAttribution, YieldSourceRisk } from "@shared/types/yield";
import type { DEWSInput, SignalResult, WorstPoolComponentStatus, WorstPoolUnavailableReason } from "./types";
import { piecewiseLinear } from "./compatibility";
import { deriveDepegSignal } from "../depeg-signals";

// ---------------------------------------------------------------------------
// Source-quality scoring tables
// ---------------------------------------------------------------------------

const CONFIDENCE_SCORES: Record<string, number> = {
  high: 0,
  "single-source": 25,
  low: 60,
  fallback: 80,
};

/**
 * An absent, blank or unrecognised price-confidence tier is unvalidated
 * evidence, not a high-confidence reading: score it as the worst known tier
 * (R1) so a missing label can never publish as measured calm.
 */
const UNMAPPED_CONFIDENCE_SCORE = Math.max(...Object.values(CONFIDENCE_SCORES));

function confidenceScore(confidence: string | null | undefined): number {
  const tier = confidence?.trim() ?? "";
  return Object.prototype.hasOwnProperty.call(CONFIDENCE_SCORES, tier) ? CONFIDENCE_SCORES[tier]! : UNMAPPED_CONFIDENCE_SCORE;
}

/**
 * Scores for the yield-warning vocabulary `detectWarningSignals()` emits.
 * `YIELD_WARNING_SIGNAL_KEYS` is the producer-side authority and
 * `signal-families.test.ts` pins that this table covers it (R5).
 * `zero-yield` is an APY-collapse editorial flag rather than a depeg-stress
 * driver, so it is recognised and scored zero — a row carrying only unscored
 * keys publishes no verdict at all instead of a measured zero.
 */
export const YIELD_WARNING_SCORES: Record<string, number> = {
  "yield-spike": 30,
  "yield-divergence": 25,
  "tvl-outflow": 35,
  "negative-trend": 15,
  "reward-heavy": 20,
  "zero-yield": 0,
};

// ---------------------------------------------------------------------------
// Signal families
// ---------------------------------------------------------------------------

export function computeSupplySignal(input: DEWSInput): SignalResult {
  const { circulatingCurrent, circulatingPrevDay, circulatingPrevWeek, mcapUsd } = input;
  const prevDayAvailable = input.circulatingPrevDayAvailable ?? true;
  const prevWeekAvailable = input.circulatingPrevWeekAvailable ?? true;

  if (!prevDayAvailable && !prevWeekAvailable) {
    return { value: 0, available: false, unavailableReason: "supply-history-anchors-missing" };
  }

  if ((!prevDayAvailable || circulatingPrevDay <= 0) && (!prevWeekAvailable || circulatingPrevWeek <= 0)) {
    return { value: 0, available: true, delta1d: 0, delta7d: 0 };
  }

  const delta1d =
    prevDayAvailable && circulatingPrevDay > 0 ? (circulatingCurrent - circulatingPrevDay) / circulatingPrevDay : 0;
  const delta7d =
    prevWeekAvailable && circulatingPrevWeek > 0 ? (circulatingCurrent - circulatingPrevWeek) / circulatingPrevWeek : 0;

  // Only contraction contributes stress
  const norm1d =
    delta1d >= 0
      ? 0
      : piecewiseLinear(Math.abs(delta1d) * 100, [
          // Supply contraction stress curve (1d).
          // Calibrated from historical redemption events:
          //   1% daily: routine rebalancing, minimal concern
          //   3-5%: observed in moderate stress (e.g., USDC March 2023)
          //   10-20%: bank-run territory (e.g., UST May 2022)
          [0, 0],
          [1, 15],
          [3, 40],
          [5, 65],
          [10, 85],
          [20, 100],
        ]);

  const norm7d =
    delta7d >= 0
      ? 0
      : piecewiseLinear(Math.abs(delta7d) * 100, [
          // Supply contraction stress curve (7d).
          // Wider thresholds than 1d because weekly changes are naturally larger.
          //   3%: normal weekly variation
          //   7-15%: sustained outflows (e.g., post-crisis BUSD wind-down)
          //   30%+: catastrophic collapse
          [0, 0],
          [3, 15],
          [7, 40],
          [15, 70],
          [30, 100],
        ]);

  const rawVelocity = 0.6 * norm1d + 0.4 * norm7d;

  // Size-adjusted dampening: small coins (<$50M) have naturally volatile supply
  const sizeFactor = Math.min(1, Math.log10(Math.max(mcapUsd, 1e6) / 1e6) / 3);

  const value = clamp(rawVelocity * sizeFactor, 0, 100);

  return {
    value,
    available: true,
    delta1d: Math.round(delta1d * 10000) / 100, // as percentage
    delta7d: Math.round(delta7d * 10000) / 100,
    sizeFactor: Math.round(sizeFactor * 100) / 100,
  };
}

// Pool signal blend: 40% balance stress, 35% avg pool stress, 25% worst single pool.
// Balance ratio weighted highest because it directly measures exit liquidity.
// Worst pool at 25% ensures a single severely imbalanced pool can't be masked
// by many healthy pools.
const POOL_BALANCE_WEIGHT = 0.4;
const POOL_AVG_STRESS_WEIGHT = 0.35;
const POOL_WORST_WEIGHT = 0.25;
/** Balance + average stress: both are required for the signal to be available at all. */
const POOL_REQUIRED_COMPONENT_WEIGHT = POOL_BALANCE_WEIGHT + POOL_AVG_STRESS_WEIGHT;
const WORST_POOL_MIN_TVL_USD = 100_000;

interface WorstPoolComponent {
  status: WorstPoolComponentStatus;
  /** `null` whenever the component is unavailable; `empty` is a measured zero. */
  value: number | null;
  reason?: WorstPoolUnavailableReason;
}

function assessWorstPool(input: DEWSInput): WorstPoolComponent {
  if (input.topPools == null) {
    return { status: "unavailable", value: null, reason: input.topPoolsUnavailableReason ?? "top-pools-missing" };
  }
  let eligible = 0;
  let measured = 0;
  let worst = 0;
  for (const pool of input.topPools) {
    if (!(pool.tvlUsd >= WORST_POOL_MIN_TVL_USD)) continue;
    eligible += 1;
    // A pool without a balance measurement is excluded, never read as perfect balance.
    if (pool.balanceRatio == null || !Number.isFinite(pool.balanceRatio)) continue;
    measured += 1;
    worst = Math.max(worst, clamp((1 - pool.balanceRatio) * 100, 0, 100));
  }
  // Observed empty eligible set: no single large pool exists to be imbalanced.
  if (eligible === 0) return { status: "empty", value: 0 };
  if (measured === 0) return { status: "unavailable", value: null, reason: "top-pools-balance-unmeasured" };
  return { status: "observed", value: worst };
}

export function computePoolSignal(input: DEWSInput): SignalResult {
  if (
    input.weightedBalanceRatio == null ||
    !Number.isFinite(input.weightedBalanceRatio) ||
    input.avgPoolStress == null ||
    !Number.isFinite(input.avgPoolStress)
  ) {
    return { value: 0, available: false };
  }

  // Invert balance ratio so higher = more stress
  const balanceStress = (1 - input.weightedBalanceRatio) * 100;
  // avg_pool_stress is already 0-100 in the DB
  const poolStressScore = input.avgPoolStress;
  const worstPool = assessWorstPool(input);

  // An unavailable worst-pool component drops out of both numerator and denominator (DEC-04): the
  // blend renormalizes over the readable components instead of adding a measured-looking zero.
  let weightedSum = POOL_BALANCE_WEIGHT * balanceStress + POOL_AVG_STRESS_WEIGHT * poolStressScore;
  let componentCoverage = POOL_REQUIRED_COMPONENT_WEIGHT;
  if (worstPool.value != null) {
    weightedSum += POOL_WORST_WEIGHT * worstPool.value;
    componentCoverage += POOL_WORST_WEIGHT;
  }
  let value = clamp(weightedSum / componentCoverage, 0, 100);

  // Smooth only against a previous observation built from the same readable components: a persisted
  // unavailable signal is `{value: 0, available: false}`, and a reading with different component
  // coverage (or legacy unknown coverage) measured a different blend, so averaging either would mix
  // absent evidence into the current reading.
  let smoothing: SignalResult["smoothing"];
  if (input.prevPoolValue === undefined) {
    smoothing = "no-previous";
  } else if (input.prevPoolAvailable !== true) {
    smoothing = "previous-unavailable";
  } else if (input.prevPoolComponentCoverage == null) {
    smoothing = "previous-coverage-unknown";
  } else if (input.prevPoolComponentCoverage !== componentCoverage) {
    smoothing = "coverage-changed";
  } else {
    value = (value + input.prevPoolValue) / 2;
    smoothing = "applied";
  }

  return {
    value,
    available: true,
    balanceRatio: input.weightedBalanceRatio,
    avgPoolStress: input.avgPoolStress,
    worstPool: worstPool.value == null ? null : Math.round(worstPool.value * 100) / 100,
    worstPoolStatus: worstPool.status,
    ...(worstPool.reason ? { worstPoolUnavailableReason: worstPool.reason } : {}),
    componentCoverage,
    smoothing,
  };
}

export function computeLiquiditySignal(input: DEWSInput): SignalResult {
  const { liquidityScore, liquidityScore7dAgo, tvlCurrent, tvl7dAgo } = input;

  const scoreDeltaComputable = liquidityScore !== null && liquidityScore7dAgo !== null && liquidityScore7dAgo > 0;
  const tvlDeltaComputable = tvlCurrent !== null && tvl7dAgo !== null && tvl7dAgo > 0;

  if (liquidityScore === null || (!scoreDeltaComputable && !tvlDeltaComputable)) {
    return { value: 0, available: false };
  }

  // Score erosion
  let scoreErosion = 0;
  if (liquidityScore7dAgo !== null && liquidityScore7dAgo > 0) {
    const scoreDelta = (liquidityScore - liquidityScore7dAgo) / Math.max(liquidityScore7dAgo, 1);
    if (scoreDelta < 0) {
      scoreErosion = piecewiseLinear(Math.abs(scoreDelta) * 100, [
        // Liquidity score erosion curve.
        //   5% drop: minor noise, market makers rebalancing
        //   15-30%: meaningful degradation, possible exit liquidity concern
        //   50%+: severe — DEX coverage collapsing
        [0, 0],
        [5, 15],
        [15, 40],
        [30, 70],
        [50, 100],
      ]);
    }
  }

  // TVL erosion
  let tvlErosion = 0;
  if (tvlCurrent !== null && tvl7dAgo !== null && tvl7dAgo > 0) {
    const tvlDelta = (tvlCurrent - tvl7dAgo) / tvl7dAgo;
    if (tvlDelta < 0) {
      tvlErosion = piecewiseLinear(Math.abs(tvlDelta) * 100, [
        // TVL erosion curve.
        //   10% drop: normal weekly TVL fluctuation
        //   25-50%: significant LP withdrawal, possible contagion
        //   75%+: near-total liquidity exit
        [0, 0],
        [10, 15],
        [25, 40],
        [50, 70],
        [75, 100],
      ]);
    }
  }

  const value = clamp(0.5 * scoreErosion + 0.5 * tvlErosion, 0, 100);

  return {
    value,
    available: true,
    scoreDelta7d:
      liquidityScore7dAgo !== null
        ? Math.round(((liquidityScore - liquidityScore7dAgo) / Math.max(liquidityScore7dAgo, 1)) * 10000) / 100
        : null,
    tvlDelta7d:
      tvlCurrent !== null && tvl7dAgo !== null && tvl7dAgo > 0
        ? Math.round(((tvlCurrent - tvl7dAgo) / tvl7dAgo) * 10000) / 100
        : null,
  };
}

export function computePriceSignal(input: DEWSInput): SignalResult {
  const { price, priceConfidence, prevPriceConfidence } = input;

  // No price at all = maximum concern. We deliberately return available:true
  // (not available:false) so the 100 stress points feed the DEWS score even
  // when there is no reading — here available:true means "this signal has a
  // verdict", not "we have a live price". Note this stress does NOT add
  // market-price evidence: classifyEvidenceKinds() requires an available stressed
  // divergence reading from at least one observed primary or DEX leg. Without
  // either leg a null-price coin can still be WATCH-capped for lack of evidence;
  // data unavailability itself is not observed market stress.
  if (price === null || price === undefined || !Number.isFinite(price)) {
    return { value: 100, available: true, confidence: null };
  }

  const currScore = confidenceScore(priceConfidence);
  let value = currScore;

  // Degradation transition bonus — suppress for the high→single-source
  // reclassification caused by the consensus honesty fix (not a real degradation)
  if (prevPriceConfidence) {
    const prevScore = confidenceScore(prevPriceConfidence);
    if (currScore > prevScore && !(prevPriceConfidence === "high" && (priceConfidence ?? "") === "single-source")) {
      value = Math.min(100, value + 15);
    }
  }

  const unmappedTier = !Object.prototype.hasOwnProperty.call(CONFIDENCE_SCORES, priceConfidence?.trim() ?? "");
  return {
    value,
    available: true,
    confidence: priceConfidence,
    ...(unmappedTier ? { warnings: ["price-confidence-unmapped"] } : {}),
  };
}

export function computeDivergSignal(input: DEWSInput): SignalResult {
  const { price, dexPriceUsd, pegRef, pegType } = input;

  // Admit each observed price leg independently against the same peg reference.
  if (input.pegReferenceAvailable === false || !Number.isFinite(pegRef) || pegRef <= 0) {
    return {
      value: 0,
      available: false,
      unavailableReason: input.pegReferenceUnavailableReason ?? "peg-reference-unavailable",
    };
  }

  // Canonical derivation rejects missing, non-finite and non-positive prices.
  const primary = price === null ? null : deriveDepegSignal(price, pegRef);
  const dex = dexPriceUsd === null ? null : deriveDepegSignal(dexPriceUsd, pegRef);
  if (primary === null && dex === null) {
    return { value: 0, available: false, unavailableReason: "invalid-price" };
  }
  const primaryDevBps = primary?.absBps;
  const dexDevBps = dex?.absBps;
  const crossSpreadBps = primary !== null && dex !== null && price !== null && dexPriceUsd !== null
    ? deriveDepegSignal(price, dexPriceUsd)?.absBps ?? 0
    : 0;
  const worstBps = Math.max(primaryDevBps ?? 0, dexDevBps ?? 0, crossSpreadBps);

  // Cross-source price divergence curve (basis points).
  //   25bps: normal bid-ask spread noise
  //   50-75bps: meaningful divergence, worth monitoring
  //   100-200bps: serious disagreement between sources
  //   500bps+: extreme — data error or genuine crisis
  let value = piecewiseLinear(worstBps, [
    [0, 0],
    [25, 10],
    [50, 25],
    [75, 50],
    [100, 75],
    [200, 90],
    [500, 100],
  ]);

  // Dampen for non-USD pegs (noisier pricing)
  if (pegType !== "peggedUSD") {
    value *= 0.7;
  }

  // Smooth only against an available previous reading (see computePoolSignal).
  if (input.prevDivergValue !== undefined && input.prevDivergAvailable === true) {
    value = (value + input.prevDivergValue) / 2;
  }

  return {
    value,
    available: true,
    // Already canonical integers from `deriveDepegSignal`.
    spreadBps: worstBps,
    primaryDevBps,
    dexDevBps,
  };
}

export function computeBlacklistSignal(input: DEWSInput): SignalResult {
  if (!input.hasBlacklistTracking || input.blacklistSourceOk === false) {
    return {
      value: 0,
      available: false,
      ...(!input.hasBlacklistTracking ? {} : { unavailableReason: "blacklist-source-failed" }),
    };
  }

  const { blacklistEvents24h, blacklistEvents7d } = input;
  const dailyRate7d = blacklistEvents7d / 7;

  // Spike detection
  const spikeRatio = dailyRate7d > 0 ? blacklistEvents24h / dailyRate7d : blacklistEvents24h;

  const rawCount = piecewiseLinear(blacklistEvents24h, [
    // Blacklist event count curve (24h).
    //   2 events: routine compliance (OFAC updates, singular freeze)
    //   5-10: elevated activity, possibly coordinated enforcement
    //   20-50: mass freeze — emergency response or regulatory action
    [0, 0],
    [2, 10],
    [5, 30],
    [10, 55],
    [20, 80],
    [50, 100],
  ]);

  const spikeMult = piecewiseLinear(spikeRatio, [
    // Spike multiplier: how much today's blacklist activity exceeds the 7d daily avg.
    //   1x: normal rate → 0.7x dampening (activity consistent with baseline)
    //   3x: notable spike → 1.0x (no adjustment)
    //   5-10x: extreme spike → 1.2-1.5x amplification
    //   <1x baseline: 0.5x dampening (activity declining)
    [0, 0.5],
    [1, 0.7],
    [3, 1.0],
    [5, 1.2],
    [10, 1.5],
  ]);

  const value = clamp(rawCount * spikeMult, 0, 100);

  return {
    value,
    available: true,
    events24h: blacklistEvents24h,
    events7d: blacklistEvents7d,
    spikeRatio: Math.round(spikeRatio * 100) / 100,
  };
}

export function computeFlowSignal(input: DEWSInput): SignalResult {
  const baselineDays = input.flowBaselineDays ?? 0;

  // Unavailable if mint/burn values are missing, the baseline is too thin, or
  // the latest hourly source row is stale.
  if (
    input.burnVolume24hUsd === null ||
    input.mintVolume24hUsd === null ||
    input.burnBaseline30dUsd === null
  ) {
    return { value: 0, available: false, baselineDays, unavailableReason: "mint-burn-data-missing" };
  }
  if (baselineDays < 7) {
    return { value: 0, available: false, baselineDays, unavailableReason: "mint-burn-baseline-too-short" };
  }
  if (!Number.isFinite(input.flowDataAgeDays) || input.flowDataAgeDays > 1) {
    return { value: 0, available: false, baselineDays, unavailableReason: "mint-burn-stale" };
  }
  // Missing USD valuation is never read as zero dollars (D11-2): unpriced 24h
  // burns understate the surge and unpriced 24h mints overstate the ratio, and
  // unpriced baseline burns overstate the surge. Unknown (pre-completeness)
  // baseline coverage is tolerated until legacy hourly buckets age out.
  if (input.flowValuation24h !== "complete") {
    return {
      value: 0,
      available: false,
      baselineDays,
      unavailableReason: input.flowValuation24h === "partial" ? "mint-burn-valuation-partial" : "mint-burn-valuation-unknown",
    };
  }
  if (input.flowBurnBaselineValuation === "partial") {
    return { value: 0, available: false, baselineDays, unavailableReason: "mint-burn-baseline-valuation-partial" };
  }

  // Burn surge: how much 24h burns exceed the 30d daily average
  const burnSurge =
    input.burnBaseline30dUsd > 0
      ? input.burnVolume24hUsd / input.burnBaseline30dUsd
      : input.burnVolume24hUsd > 1e6
        ? 5
        : 0;

  // Mint/burn ratio collapse: when burns >> mints
  const ratio =
    input.mintVolume24hUsd > 0 ? input.burnVolume24hUsd / input.mintVolume24hUsd : input.burnVolume24hUsd > 0 ? 10 : 0;

  const surgeScore = piecewiseLinear(burnSurge, [
    // Burn surge curve: 24h burn volume vs 30d daily average.
    //   1x: at baseline — minimal concern
    //   2-3x: elevated redemptions, early stress signal
    //   5-10x: panic redemptions (e.g., UST spiral, USDC March 2023)
    [0, 0],
    [1, 5],
    [2, 25],
    [3, 50],
    [5, 75],
    [10, 100],
  ]);

  const ratioScore = piecewiseLinear(ratio, [
    // Burn-to-mint ratio curve: when burns >> mints, redemptions dominate.
    //   1x: balanced flow — normal
    //   2-3x: net outflows, moderate concern
    //   5-10x: one-sided redemption pressure, potential run
    [0, 0],
    [1, 5],
    [2, 20],
    [3, 40],
    [5, 65],
    [10, 100],
  ]);

  const net24h = input.mintVolume24hUsd - input.burnVolume24hUsd;
  const value = clamp(0.6 * surgeScore + 0.4 * ratioScore, 0, 100);

  return {
    value,
    available: true,
    burnSurge: Math.round(burnSurge * 100) / 100,
    burnToMintRatio: Math.round(ratio * 100) / 100,
    net24hUsd: net24h,
    baselineDays,
  };
}

/**
 * Additive structured-yield risk signal. Each condition contributes a fixed
 * increment (theoretical max ~175) and the total is clamped to [0, 100]. The
 * saturation past 100 is intentional: any combination of conditions severe
 * enough to clear ~60 already represents a maxed-out structured-yield risk, so
 * the *meaningful* discriminating range is roughly 0-60. Beyond that the signal
 * deliberately stops distinguishing between "very bad" and "even worse" — the
 * individual increment weights are tuned for ordering within that lower band,
 * not for an exact additive curve at the ceiling. Re-tuning the increments (or
 * needing per-bucket resolution at saturation) is the trigger to revisit caps.
 */
function computeStructuredYieldSignal(
  input: Pick<DEWSInput, "yieldSourceRisk" | "yieldRankChangeAttribution">,
): { value: number; warnings: string[] } | null {
  if (input.yieldSourceRisk == null && input.yieldRankChangeAttribution == null) {
    return null;
  }
  const sourceRisk: YieldSourceRisk | null | undefined = input.yieldSourceRisk;
  const attribution: YieldRankChangeAttribution | null | undefined = input.yieldRankChangeAttribution;
  const warnings: string[] = [];
  let value = 0;

  if (typeof sourceRisk?.rewardShare === "number" && sourceRisk.rewardShare > 0.5) {
    value += 20;
    warnings.push("structured-reward-heavy");
  }
  if (typeof sourceRisk?.sourceDepthRatio === "number" && sourceRisk.sourceDepthRatio < 0.001) {
    value += 35;
    warnings.push("structured-thin-source-depth");
  }
  if (typeof sourceRisk?.sourceAgeSeconds === "number" && sourceRisk.sourceAgeSeconds > 6 * 60 * 60) {
    value += 15;
    warnings.push("structured-stale-source");
  }
  // B31: the static evidence branch and the rank-attribution branch describe the
  // same condition from two sides — the switch (or penalty) the row carries, and
  // the rank move that same switch produced. Each pair therefore contributes one
  // increment: the driver branch is a no-op once its static counterpart fired.
  const countedSourceSwitch =
    typeof sourceRisk?.sourceSwitchCount30d === "number" && sourceRisk.sourceSwitchCount30d > 0;
  const countedSourceRiskPenalty =
    typeof sourceRisk?.sourceRiskPenalty === "number" && sourceRisk.sourceRiskPenalty >= 1.5;
  if (countedSourceSwitch) {
    value += 20;
    warnings.push("structured-source-switch");
  }
  if (countedSourceRiskPenalty) {
    value += 20;
    warnings.push("structured-source-risk-penalty");
  }
  if (sourceRisk?.venueRiskTier === "high") {
    value += 25;
    warnings.push("structured-high-risk-venue");
  } else if (sourceRisk?.venueRiskTier === "medium") {
    value += 10;
    warnings.push("structured-medium-risk-venue");
  }
  if (attribution?.primaryDriver === "source-switch" && !countedSourceSwitch) {
    value += 20;
    warnings.push("structured-rank-source-switch");
  } else if (attribution?.primaryDriver === "source-risk" && !countedSourceRiskPenalty) {
    value += 20;
    warnings.push("structured-rank-source-risk");
  }

  if (value <= 0) return null;
  return { value: clamp(value, 0, 100), warnings };
}

export function computeYieldSignal(input: DEWSInput): SignalResult {
  const structuredSignal = computeStructuredYieldSignal(input);

  if (input.yieldWarnings.length === 0 && !structuredSignal) {
    return { value: 0, available: false };
  }

  const warningSum = input.yieldWarnings.reduce(
    (acc, w) => acc + (Object.prototype.hasOwnProperty.call(YIELD_WARNING_SCORES, w) ? YIELD_WARNING_SCORES[w]! : 0),
    0,
  );
  const value = clamp(warningSum + (structuredSignal?.value ?? 0), 0, 100);
  const warnings = [...input.yieldWarnings, ...(structuredSignal?.warnings ?? [])];

  // Warnings that carry no scored stress (an unrecognised key, or a recognised
  // non-stress flag such as `zero-yield`) are not a measured clean reading:
  // publish no verdict rather than a zero that renormalisation reads as calm.
  if (value === 0) {
    return { value, available: false, unavailableReason: "yield-warnings-unscored", warnings };
  }

  return {
    value,
    available: true,
    warnings,
  };
}
