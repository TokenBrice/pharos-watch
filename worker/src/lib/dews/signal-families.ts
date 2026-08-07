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
import type { DEWSInput, SignalResult } from "./types";
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

const YIELD_WARNING_SCORES: Record<string, number> = {
  "yield-spike": 30,
  "yield-divergence": 25,
  "tvl-outflow": 35,
  "negative-trend": 15,
  "reward-heavy": 20,
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

  // Worst single pool imbalance
  let worstPoolSignal = 0;
  if (input.topPools) {
    for (const pool of input.topPools) {
      if (pool.tvlUsd >= 100_000) {
        const imbalance = (1 - pool.balanceRatio) * 100;
        worstPoolSignal = Math.max(worstPoolSignal, imbalance);
      }
    }
  }

  let value = clamp(
    // Pool signal blend: 40% balance stress, 35% avg pool stress, 25% worst single pool.
    // Balance ratio weighted highest because it directly measures exit liquidity.
    // Worst pool at 25% ensures a single severely imbalanced pool can't be masked
    // by many healthy pools.
    0.4 * balanceStress + 0.35 * poolStressScore + 0.25 * worstPoolSignal,
    0,
    100,
  );

  // Smooth with previous reading if available
  if (input.prevPoolValue !== undefined) {
    value = (value + input.prevPoolValue) / 2;
  }

  return {
    value,
    available: true,
    balanceRatio: input.weightedBalanceRatio,
    avgPoolStress: input.avgPoolStress,
    worstPool: Math.round(worstPoolSignal * 100) / 100,
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
  // market-price evidence: classifyEvidenceKinds() in evidence-policy.ts gates
  // the market-price kind on signals.diverg + input.price !== null, so a
  // null-price coin can be pushed up by this 100 yet still be WATCH-capped for
  // lack of evidence. That asymmetry is intentional (data-unavailability is not
  // observed depeg evidence); change both call sites together if it ever needs
  // to count as its own evidence kind.
  if (price === null || price === undefined || !Number.isFinite(price)) {
    return { value: 100, available: true, confidence: null };
  }

  let value = CONFIDENCE_SCORES[priceConfidence ?? ""] ?? 0;

  // Degradation transition bonus — suppress for the high→single-source
  // reclassification caused by the consensus honesty fix (not a real degradation)
  if (prevPriceConfidence) {
    const prevScore = CONFIDENCE_SCORES[prevPriceConfidence] ?? 0;
    const currScore = CONFIDENCE_SCORES[priceConfidence ?? ""] ?? 0;
    if (currScore > prevScore && !(prevPriceConfidence === "high" && (priceConfidence ?? "") === "single-source")) {
      value = Math.min(100, value + 15);
    }
  }

  return {
    value,
    available: true,
    confidence: priceConfidence,
  };
}

export function computeDivergSignal(input: DEWSInput): SignalResult {
  const { price, dexPriceUsd, pegRef, pegType } = input;

  // Need at least primary price to compute any divergence
  if (input.pegReferenceAvailable === false || pegRef <= 0) {
    return {
      value: 0,
      available: false,
      unavailableReason: input.pegReferenceUnavailableReason ?? "peg-reference-unavailable",
    };
  }

  if (price === null || !Number.isFinite(price)) {
    return { value: 0, available: false };
  }

  // Deviations come from the canonical depeg-signal derivation so DEWS and the
  // depeg detector answer "how far from peg is this price" with one formula.
  // `absBps` is the canonical (rounded) basis-point reading; the derivation
  // also fail-closes on non-positive prices, which the previous inline
  // arithmetic silently turned into nonsense magnitudes.
  const primaryDevBps = deriveDepegSignal(price, pegRef)?.absBps ?? 0;

  // DEX deviation from peg (bps)
  const dexDevBps = dexPriceUsd !== null ? (deriveDepegSignal(dexPriceUsd, pegRef)?.absBps ?? 0) : 0;

  // Cross-source spread (bps)
  const crossSpreadBps =
    dexPriceUsd !== null ? (deriveDepegSignal(price, dexPriceUsd)?.absBps ?? 0) : 0;

  const worstBps = Math.max(primaryDevBps, dexDevBps, crossSpreadBps);

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

  // Smooth with previous reading if available
  if (input.prevDivergValue !== undefined) {
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
  if (!input.hasBlacklistTracking) {
    return { value: 0, available: false };
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
  if (typeof sourceRisk?.sourceSwitchCount30d === "number" && sourceRisk.sourceSwitchCount30d > 0) {
    value += 20;
    warnings.push("structured-source-switch");
  }
  if (typeof sourceRisk?.sourceRiskPenalty === "number" && sourceRisk.sourceRiskPenalty >= 1.5) {
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
  if (attribution?.primaryDriver === "source-switch") {
    value += 20;
    warnings.push("structured-rank-source-switch");
  } else if (attribution?.primaryDriver === "source-risk") {
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

  const warningSum = input.yieldWarnings.reduce((acc, w) => acc + (YIELD_WARNING_SCORES[w] ?? 0), 0);
  const value = clamp(warningSum + (structuredSignal?.value ?? 0), 0, 100);

  return {
    value,
    available: true,
    warnings: [...input.yieldWarnings, ...(structuredSignal?.warnings ?? [])],
  };
}
