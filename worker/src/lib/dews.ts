/**
 * Depeg Early Warning Score (DEWS) — pure, stateless compute function.
 *
 * Estimates per-coin depeg probability using 8 sub-signals (0-100 each),
 * combined via weighted average with redistribution for missing signals.
 *
 * Pattern: same as stability-index.ts — no DB access, no side effects.
 */

import type { ThreatBand } from "@shared/lib/classification";
import { clamp } from "@shared/lib/math";
import {
  DEWS_SIGNAL_WEIGHTS,
  DEWS_THREAT_BANDS,
} from "@shared/lib/dews-config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { ThreatBand };

export interface PoolEntry {
  tvlUsd: number;
  balanceRatio: number;
}

export interface SignalResult {
  value: number; // 0-100
  available: boolean;
  // Debug fields per signal (optional, set by individual compute functions)
  delta1d?: number;
  delta7d?: number;
  sizeFactor?: number;
  balanceRatio?: number;
  avgPoolStress?: number;
  worstPool?: number;
  scoreDelta7d?: number | null;
  tvlDelta7d?: number | null;
  confidence?: string | null;
  spreadBps?: number;
  primaryDevBps?: number;
  dexDevBps?: number;
  events24h?: number;
  events7d?: number;
  spikeRatio?: number;
  burnSurge?: number;
  burnToMintRatio?: number;
  net24hUsd?: number;
  warnings?: string[];
}

export interface DEWSInput {
  stablecoinId: string;
  mcapUsd: number;
  pegType: string;
  // Supply velocity
  circulatingCurrent: number;
  circulatingPrevDay: number;
  circulatingPrevWeek: number;
  // Pool balance
  weightedBalanceRatio: number | null;
  avgPoolStress: number | null;
  topPools: PoolEntry[] | null;
  // Liquidity erosion
  liquidityScore: number | null;
  liquidityScore7dAgo: number | null;
  tvlCurrent: number | null;
  tvl7dAgo: number | null;
  // Price confidence
  priceConfidence: string | null;
  prevPriceConfidence: string | null;
  price: number | null;
  // Cross-source divergence
  pegRef: number;
  dexPriceUsd: number | null;
  // Blacklist activity
  blacklistEvents24h: number;
  blacklistEvents7d: number;
  hasBlacklistTracking: boolean;
  // Mint/burn flow (optional — from mint_burn_hourly)
  burnVolume24hUsd: number | null;
  mintVolume24hUsd: number | null;
  burnBaseline30dUsd: number | null;
  flowDataAgeDays: number;
  // Yield anomaly (optional — from yield_data.warning_signals)
  yieldWarnings: string[];
  // Systemic backdrop (optional — latest PSI score from previous cycle)
  psiScore: number | null;
  // Smoothing (optional — previous reading for averaging)
  prevPoolValue?: number;
  prevDivergValue?: number;
}

export interface DEWSResult {
  score: number;
  band: ThreatBand;
  signals: Record<string, SignalResult>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONFIDENCE_SCORES: Record<string, number> = {
  high: 0,
  "single-source": 25,
  low: 60,
  fallback: 80,
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Generic piecewise linear interpolation.
 * Anchors must be sorted by x ascending. Values below first anchor return
 * first y; values above last anchor return last y.
 */
export function piecewiseLinear(
  x: number,
  anchors: [number, number][],
): number {
  if (anchors.length === 0) return 0;
  if (!Number.isFinite(x))
    return x !== x ? 0 : x > 0 ? anchors[anchors.length - 1][1] : anchors[0][1];
  if (x <= anchors[0][0]) return anchors[0][1];
  if (x >= anchors[anchors.length - 1][0]) return anchors[anchors.length - 1][1];

  for (let i = 1; i < anchors.length; i++) {
    if (x <= anchors[i][0]) {
      const [x0, y0] = anchors[i - 1];
      const [x1, y1] = anchors[i];
      const t = (x - x0) / (x1 - x0);
      return y0 + t * (y1 - y0);
    }
  }
  return anchors[anchors.length - 1][1];
}

// ---------------------------------------------------------------------------
// Band mapping
// ---------------------------------------------------------------------------

export function getThreatBand(score: number): ThreatBand {
  for (const threshold of DEWS_THREAT_BANDS) {
    if (score <= threshold.upper) return threshold.band;
  }
  return "DANGER";
}

// ---------------------------------------------------------------------------
// Sub-signal implementations
// ---------------------------------------------------------------------------

function computeSupplySignal(input: DEWSInput): SignalResult {
  const { circulatingCurrent, circulatingPrevDay, circulatingPrevWeek, mcapUsd } =
    input;

  if (circulatingPrevDay <= 0 && circulatingPrevWeek <= 0) {
    return { value: 0, available: true, delta1d: 0, delta7d: 0 };
  }

  const delta1d =
    circulatingPrevDay > 0
      ? (circulatingCurrent - circulatingPrevDay) / circulatingPrevDay
      : 0;
  const delta7d =
    circulatingPrevWeek > 0
      ? (circulatingCurrent - circulatingPrevWeek) / circulatingPrevWeek
      : 0;

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
  const sizeFactor = Math.min(
    1,
    Math.log10(Math.max(mcapUsd, 1e6) / 1e6) / 3,
  );

  const value = clamp(rawVelocity * sizeFactor, 0, 100);

  return {
    value,
    available: true,
    delta1d: Math.round(delta1d * 10000) / 100, // as percentage
    delta7d: Math.round(delta7d * 10000) / 100,
    sizeFactor: Math.round(sizeFactor * 100) / 100,
  };
}

function computePoolSignal(input: DEWSInput): SignalResult {
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

function computeLiquiditySignal(input: DEWSInput): SignalResult {
  const { liquidityScore, liquidityScore7dAgo, tvlCurrent, tvl7dAgo } = input;

  if (liquidityScore === null) {
    return { value: 0, available: false };
  }

  // Score erosion
  let scoreErosion = 0;
  if (liquidityScore7dAgo !== null && liquidityScore7dAgo > 0) {
    const scoreDelta =
      (liquidityScore - liquidityScore7dAgo) /
      Math.max(liquidityScore7dAgo, 1);
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
        ? Math.round(
            ((liquidityScore - liquidityScore7dAgo) /
              Math.max(liquidityScore7dAgo, 1)) *
              10000,
          ) / 100
        : null,
    tvlDelta7d:
      tvlCurrent !== null && tvl7dAgo !== null && tvl7dAgo > 0
        ? Math.round(((tvlCurrent - tvl7dAgo) / tvl7dAgo) * 10000) / 100
        : null,
  };
}

function computePriceSignal(input: DEWSInput): SignalResult {
  const { price, priceConfidence, prevPriceConfidence } = input;

  // No price at all = maximum concern
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

function computeDivergSignal(input: DEWSInput): SignalResult {
  const { price, dexPriceUsd, pegRef, pegType } = input;

  // Need at least primary price to compute any divergence
  if (price === null || !Number.isFinite(price) || pegRef <= 0) {
    return { value: 0, available: false };
  }

  // Primary deviation from peg (bps)
  const primaryDevBps = Math.abs((price / pegRef - 1) * 10000);

  // DEX deviation from peg (bps)
  const dexDevBps =
    dexPriceUsd !== null
      ? Math.abs((dexPriceUsd / pegRef - 1) * 10000)
      : 0;

  // Cross-source spread (bps)
  const crossSpreadBps =
    dexPriceUsd !== null && price > 0
      ? Math.abs((price / dexPriceUsd - 1) * 10000)
      : 0;

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
    spreadBps: Math.round(worstBps * 100) / 100,
    primaryDevBps: Math.round(primaryDevBps * 100) / 100,
    dexDevBps: Math.round(dexDevBps * 100) / 100,
  };
}

function computeBlacklistSignal(input: DEWSInput): SignalResult {
  if (!input.hasBlacklistTracking) {
    return { value: 0, available: false };
  }

  const { blacklistEvents24h, blacklistEvents7d } = input;
  const dailyRate7d = blacklistEvents7d / 7;

  // Spike detection
  const spikeRatio =
    dailyRate7d > 0 ? blacklistEvents24h / dailyRate7d : blacklistEvents24h;

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

function computeFlowSignal(input: DEWSInput): SignalResult {
  // Unavailable if no mint-burn data or data too young
  if (
    input.burnVolume24hUsd === null ||
    input.mintVolume24hUsd === null ||
    input.burnBaseline30dUsd === null ||
    input.flowDataAgeDays < 7
  ) {
    return { value: 0, available: false };
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
    input.mintVolume24hUsd > 0
      ? input.burnVolume24hUsd / input.mintVolume24hUsd
      : input.burnVolume24hUsd > 0
        ? 10
        : 0;

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
  };
}

const YIELD_WARNING_SCORES: Record<string, number> = {
  "yield-spike": 30,
  "yield-divergence": 25,
  "tvl-outflow": 35,
  "negative-trend": 15,
  "reward-heavy": 20,
};

function computeYieldSignal(input: DEWSInput): SignalResult {
  if (input.yieldWarnings.length === 0) {
    return { value: 0, available: false };
  }

  const sum = input.yieldWarnings.reduce(
    (acc, w) => acc + (YIELD_WARNING_SCORES[w] ?? 0),
    0,
  );
  const value = clamp(sum, 0, 100);

  return { value, available: true, warnings: input.yieldWarnings };
}

// ---------------------------------------------------------------------------
// Main compute
// ---------------------------------------------------------------------------

export function computeDEWS(input: DEWSInput): DEWSResult | null {
  const signals: Record<keyof typeof DEWS_SIGNAL_WEIGHTS, SignalResult> = {
    supply: computeSupplySignal(input),
    pool: computePoolSignal(input),
    liq: computeLiquiditySignal(input),
    price: computePriceSignal(input),
    diverg: computeDivergSignal(input),
    black: computeBlacklistSignal(input),
    flow: computeFlowSignal(input),
    yield: computeYieldSignal(input),
  };

  // Weighted average with redistribution for missing signals
  let totalWeight = 0;
  let weightedSum = 0;

  for (const [key, signal] of Object.entries(signals) as Array<[keyof typeof signals, SignalResult]>) {
    if (signal.available) {
      totalWeight += DEWS_SIGNAL_WEIGHTS[key];
      weightedSum += DEWS_SIGNAL_WEIGHTS[key] * signal.value;
    }
  }

  // Require at least 2 available signals (weight >= 0.30) for a score
  if (totalWeight < 0.3) {
    return null;
  }

  // Systemic backdrop: amplify individual stress when market is under pressure
  let amplifiedScore = weightedSum / totalWeight;
  if (input.psiScore !== null && input.psiScore < 75) {
    // PSI < 75 (below STEADY) = market stress
    // At PSI 75: no amplification. At PSI 40: 15% amplification. At PSI 0: 30% amplification.
    const amplifier = 1 + Math.max(0, (75 - input.psiScore) / 75) * 0.3;
    amplifiedScore *= amplifier;
  }
  const score = Math.round(clamp(amplifiedScore, 0, 100));
  const band = getThreatBand(score);

  return { score, band, signals };
}
