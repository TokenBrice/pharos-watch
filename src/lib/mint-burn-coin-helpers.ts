import type { MintBurnCoinFlow, MintBurnValuationCompleteness } from "@shared/types";
import {
  getNetFlowDirection24h,
  getPressureShiftState,
  type NetFlowDirection24h,
  type PressureShiftState,
} from "@shared/lib/mint-burn-signals";
import {
  combineMintBurnValuationCompleteness,
  provenNetFlowDirection24h,
  resolveMintBurnValuation,
} from "@shared/lib/mint-burn-valuation";
import {
  resolveMintBurnSignedNet,
  sumMintBurnSignedNets,
  type MintBurnSignedNetView,
} from "@/lib/mint-burn-valuation-display";

export type MintBurnNetWindow = "24h" | "7d" | "30d" | "90d";

const PRESSURE_PARTIAL_VALUATION_NOTE =
  "Partial valuation: unpriced events in the 24h window or 30-day baseline; pressure shift unavailable";

/** Canonical activity inference — checks explicit flag first, then derives from fields. */
export function inferHas24hActivity(coin: MintBurnCoinFlow): boolean {
  if (coin.has24hActivity !== undefined) return coin.has24hActivity;
  return Boolean(
    coin.mintCount24h
    || coin.burnCount24h
    || coin.mintVolume24hUsd
    || coin.burnVolume24hUsd
    || coin.netFlow24hUsd,
  );
}

/** Signed net for one window, gated by that window's valuation completeness (absent → `unknown`). */
export function resolveCoinNetFlow(coin: MintBurnCoinFlow, window: MintBurnNetWindow): MintBurnSignedNetView {
  switch (window) {
    case "24h":
      return resolveMintBurnSignedNet(coin.netFlow24hUsd, coin.valuation?.window24h.completeness, coin.valuation?.window24h);
    case "7d":
      return resolveMintBurnSignedNet(coin.netFlow7dUsd, coin.valuation?.netFlow7d);
    case "30d":
      return resolveMintBurnSignedNet(coin.netFlow30dUsd, coin.valuation?.netFlow30d);
    case "90d":
      return resolveMintBurnSignedNet(coin.netFlow90dUsd, coin.valuation?.netFlow90d);
  }
}

/**
 * Accessible note when partial valuation (24h window or baseline) withholds the
 * pressure shift; `null` when the published score stands.
 */
export function resolvePressureUnavailableNote(coin: MintBurnCoinFlow): string | null {
  return coin.valuation?.window24h.completeness === "partial" || coin.valuation?.baseline === "partial"
    ? PRESSURE_PARTIAL_VALUATION_NOTE
    : null;
}

export function resolvePressureScore(coin: MintBurnCoinFlow): number | null {
  return resolvePressureUnavailableNote(coin) ? null : coin.pressureShiftScore;
}

export function resolvePressureState(coin: MintBurnCoinFlow): PressureShiftState {
  if (resolvePressureUnavailableNote(coin)) return "nr";
  return coin.pressureShiftState ?? getPressureShiftState(coin.pressureShiftScore);
}

/** Average daily baseline net; withheld when the baseline valuation is partial (not a bound). */
export function resolveBaselineDailyNetUsd(coin: MintBurnCoinFlow): number | null {
  return coin.valuation?.baseline === "partial" ? null : coin.baselineDailyNetUsd;
}

/**
 * 24h direction a consumer may claim; `null` when missing valuation leaves it unproven.
 * A partial window with a numeric wire net (Release A) is re-derived through the shared
 * proven-direction helper; a `null` wire direction is never replaced by a derived one.
 */
export function resolveNetDirection(coin: MintBurnCoinFlow): NetFlowDirection24h | null {
  const valuation = resolveMintBurnValuation(coin.valuation?.window24h);
  if (valuation.completeness === "partial" && coin.netFlow24hUsd != null) {
    return provenNetFlowDirection24h({
      knownNetUsd: coin.netFlow24hUsd,
      has24hActivity: inferHas24hActivity(coin),
      valuation,
    });
  }
  if (coin.netFlowDirection24h !== undefined) return coin.netFlowDirection24h;
  if (coin.netFlow24hUsd == null) return null;
  return getNetFlowDirection24h({
    netFlow24hUsd: coin.netFlow24hUsd,
    has24hActivity: inferHas24hActivity(coin),
  });
}

export interface MintBurnCoinsAggregate24h {
  /** Known-valuation gross subtotals; lower bounds unless the matching side is complete. */
  mintVolumeUsd: number;
  burnVolumeUsd: number;
  mintCompleteness: MintBurnValuationCompleteness;
  burnCompleteness: MintBurnValuationCompleteness;
  unpricedMintEventCount: number;
  unpricedBurnEventCount: number;
  /** Summed signed net; unavailable when any coin's 24h net is null or partial. */
  net: MintBurnSignedNetView;
  has24hActivity: boolean;
  /** Aggregate direction; `null` when missing valuation leaves it unproven. */
  direction: NetFlowDirection24h | null;
}

/** Client-side 24h totals across coins; never coerces an unavailable net to 0. */
export function aggregateCoinFlows24h(coins: readonly MintBurnCoinFlow[]): MintBurnCoinsAggregate24h {
  let mintVolumeUsd = 0;
  let burnVolumeUsd = 0;
  let unpricedMintEventCount = 0;
  let unpricedBurnEventCount = 0;
  let knownNetUsd: number | null = 0;
  let has24hActivity = false;
  const mintSides: MintBurnValuationCompleteness[] = [];
  const burnSides: MintBurnValuationCompleteness[] = [];
  const nets: MintBurnSignedNetView[] = [];

  for (const coin of coins) {
    const valuation = resolveMintBurnValuation(coin.valuation?.window24h);
    mintVolumeUsd += coin.mintVolume24hUsd;
    burnVolumeUsd += coin.burnVolume24hUsd;
    unpricedMintEventCount += valuation.unpricedMintEventCount;
    unpricedBurnEventCount += valuation.unpricedBurnEventCount;
    mintSides.push(valuation.mintCompleteness);
    burnSides.push(valuation.burnCompleteness);
    nets.push(resolveCoinNetFlow(coin, "24h"));
    knownNetUsd = knownNetUsd == null || coin.netFlow24hUsd == null ? null : knownNetUsd + coin.netFlow24hUsd;
    if (inferHas24hActivity(coin)) has24hActivity = true;
  }

  const net = sumMintBurnSignedNets(nets);
  const mintCompleteness = combineMintBurnValuationCompleteness(...mintSides);
  const burnCompleteness = combineMintBurnValuationCompleteness(...burnSides);
  let direction: NetFlowDirection24h | null;
  if (knownNetUsd != null) {
    direction = provenNetFlowDirection24h({
      knownNetUsd,
      has24hActivity,
      valuation: { mintCompleteness, burnCompleteness },
    });
  } else {
    direction = has24hActivity ? null : "inactive";
  }

  return {
    mintVolumeUsd,
    burnVolumeUsd,
    mintCompleteness,
    burnCompleteness,
    unpricedMintEventCount,
    unpricedBurnEventCount,
    net,
    has24hActivity,
    direction,
  };
}
