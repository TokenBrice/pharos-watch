import type { MintBurnCoinFlow, MintBurnValuationCompleteness } from "../types";
import {
  getNetFlowDirection24h,
  getPressureShiftState,
  type NetFlowDirection24h,
  type PressureShiftState,
} from "./mint-burn-signals";
import {
  combineMintBurnValuationCompleteness,
  mintBurnSignedNetBound,
  provenNetFlowDirection24h,
  resolveMintBurnValuation,
} from "./mint-burn-valuation";
import {
  describeMintBurnSignedNetBound,
  describeUnpricedEvents,
  resolveMintBurnSignedNet,
  sumMintBurnSignedNets,
  type MintBurnSignedNetView,
} from "./mint-burn-valuation-display";

export type MintBurnNetWindow = "24h" | "7d" | "30d" | "90d";

const PRESSURE_PARTIAL_VALUATION_NOTE =
  "Partial valuation: unpriced events in the 24h window or 30-day baseline; pressure shift unavailable";

/** Preserve explicit unknown activity; only older payloads without a flag infer from fields. */
export function inferHas24hActivity(coin: MintBurnCoinFlow): boolean | null {
  const classification = coin.classification?.window24h;
  if (classification && (classification.unresolvedMintEventCount > 0 || classification.unresolvedBurnEventCount > 0)) return true;
  if (coin.observed24hActivity === true) return true;
  if (classification && classification.completeness !== "complete") return null;
  if (coin.has24hActivity !== undefined) return coin.has24hActivity;
  return Boolean(
    coin.mintCount24h
    || coin.burnCount24h
    || coin.mintVolume24hUsd
    || coin.burnVolume24hUsd
    || coin.netFlow24hUsd,
  );
}

/** Legacy payloads lack subtotal semantics; new payloads need explicit scan proof for exact gross totals. */
export function hasCompleteCoinScan(coin: MintBurnCoinFlow, window: MintBurnNetWindow): boolean {
  const key = window === "24h" ? "window24h" : window === "7d" ? "window7d" : window === "30d" ? "window30d" : "window90d";
  return coin.coverage?.windows?.[key].complete ?? coin.totalsSemantics !== "observed-subtotals";
}

/** Window net gated by valuation; partial coverage is opt-in only for cells rendering a partial qualifier. */
export function resolveCoinNetFlow(coin: MintBurnCoinFlow, window: MintBurnNetWindow, allowPartialCoverage = false): MintBurnSignedNetView {
  const classification = coin.classification?.[window === "24h" ? "window24h" : window === "7d" ? "netFlow7d" : window === "30d" ? "netFlow30d" : "netFlow90d"];
  if (classification && classification.completeness !== "complete") {
    return resolveMintBurnSignedNet(null, coin.valuation?.window24h.completeness, null, null, classification);
  }
  const scanWindow = coin.coverage?.windows?.[
    window === "24h" ? "window24h" : window === "7d" ? "window7d" : window === "30d" ? "window30d" : "window90d"
  ];
  // An explicit partial-history net is the producer's admitted-leg subtotal.
  if (allowPartialCoverage && scanWindow?.complete === false && coin.coverage?.status === "partial-history") {
    const value = { "24h": coin.netFlow24hUsd, "7d": coin.netFlow7dUsd, "30d": coin.netFlow30dUsd, "90d": coin.netFlow90dUsd }[window];
    if (value != null) return resolveMintBurnSignedNet(value, window === "24h" ? coin.valuation?.window24h.completeness
      : window === "7d" ? coin.valuation?.netFlow7d : window === "30d" ? coin.valuation?.netFlow30d : coin.valuation?.netFlow90d);
  }
  if (scanWindow?.complete === false) return {
    valueUsd: null,
    completeness: resolveMintBurnValuation(coin.valuation?.window24h).completeness,
    note: `${window} scan coverage incomplete; signed net unavailable`,
  };
  if (window === "24h" && coin.has24hActivity === null) {
    return {
      valueUsd: null,
      completeness: resolveMintBurnValuation(coin.valuation?.window24h).completeness,
      note: "24h scan coverage unknown; signed net unavailable",
    };
  }
  switch (window) {
    case "24h":
      // The 24h bound derives from the published known subtotals and per-side completeness.
      return resolveMintBurnSignedNet(
        coin.netFlow24hUsd,
        coin.valuation?.window24h.completeness,
        coin.valuation?.window24h,
        coin.valuation
          ? mintBurnSignedNetBound(coin.netFlow24hUsd ?? coin.mintVolume24hUsd - coin.burnVolume24hUsd, coin.valuation.window24h)
          : null,
      );
    // Longer windows publish their bound directly (absent on pre-v6.25 payloads).
    case "7d":
      return resolveMintBurnSignedNet(coin.netFlow7dUsd, coin.valuation?.netFlow7d, null, coin.valuation?.netFlow7dBound);
    case "30d":
      return resolveMintBurnSignedNet(coin.netFlow30dUsd, coin.valuation?.netFlow30d, null, coin.valuation?.netFlow30dBound);
    case "90d":
      return resolveMintBurnSignedNet(coin.netFlow90dUsd, coin.valuation?.netFlow90d, null, coin.valuation?.netFlow90dBound);
  }
}

/**
 * Accessible note when partial valuation (24h window or baseline) withholds the
 * pressure shift; `null` when the published score stands.
 */
export function resolvePressureUnavailableNote(coin: MintBurnCoinFlow): string | null {
  const classification = [coin.classification?.window24h, coin.classification?.baseline]
    .find((verdict) => verdict && verdict.completeness !== "complete");
  if (classification) return classification.unavailableReason === "classification-unresolved"
    ? "Unresolved flow classification in the 24h window or baseline; pressure shift unavailable"
    : "Historical flow classification unknown in the 24h window or baseline; pressure shift unavailable";
  if (coin.coverage?.windows?.window24h.complete === false) return "24h scan coverage incomplete; pressure shift unavailable";
  if (coin.has24hActivity === null) return "24h scan coverage unknown; pressure shift unavailable";
  if (coin.valuation?.baseline === "unknown") return "Baseline valuation unknown; pressure shift unavailable";
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

/** Average daily baseline net requires complete evidence over the whole coin scope. */
export function resolveBaselineDailyNetUsd(coin: MintBurnCoinFlow): number | null {
  if (coin.coverage?.isPartial || coin.coverage?.windows?.window30d.complete === false
    || (coin.classification?.baseline && coin.classification.baseline.completeness !== "complete")
    || coin.valuation?.baseline !== "complete") return null;
  return coin.baselineDailyNetUsd;
}

/**
 * 24h direction a consumer may claim; `null` when missing valuation leaves it unproven.
 * A partial window with a numeric wire net (Release A) is re-derived through the shared
 * proven-direction helper; a `null` wire direction is never replaced by a derived one.
 */
export function resolveNetDirection(coin: MintBurnCoinFlow): NetFlowDirection24h | null {
  if (coin.classification?.window24h && coin.classification.window24h.completeness !== "complete") return null;
  if (coin.coverage?.windows?.window24h.complete === false) return null;
  const has24hActivity = inferHas24hActivity(coin);
  if (has24hActivity === null) return null;
  const valuation = resolveMintBurnValuation(coin.valuation?.window24h);
  if (valuation.completeness === "partial" && coin.netFlow24hUsd != null) {
    return provenNetFlowDirection24h({
      knownNetUsd: coin.netFlow24hUsd,
      has24hActivity,
      valuation,
    });
  }
  if (coin.netFlowDirection24h !== undefined) return coin.netFlowDirection24h;
  if (coin.netFlow24hUsd == null) return null;
  return getNetFlowDirection24h({
    netFlow24hUsd: coin.netFlow24hUsd,
    has24hActivity,
  });
}

export interface MintBurnCoinsAggregate24h {
  /** Known-valuation gross subtotals; lower bounds unless the matching side is complete. */
  mintVolumeUsd: number;
  burnVolumeUsd: number;
  mintCompleteness: MintBurnValuationCompleteness;
  burnCompleteness: MintBurnValuationCompleteness;
  mintClassificationCompleteness: MintBurnValuationCompleteness;
  burnClassificationCompleteness: MintBurnValuationCompleteness;
  unresolvedMintEventCount: number;
  unresolvedBurnEventCount: number;
  /** Independent of valuation: false means gross volumes are observed subtotals. */
  scanComplete: boolean;
  unpricedMintEventCount: number;
  unpricedBurnEventCount: number;
  /** Summed signed net; unavailable when any coin's 24h net is null or partial. */
  net: MintBurnSignedNetView;
  has24hActivity: boolean | null;
  /** Aggregate direction; `null` when missing valuation leaves it unproven. */
  direction: NetFlowDirection24h | null;
}

/** Client-side 24h totals across coins; never coerces an unavailable net to 0. */
export function aggregateCoinFlows24h(coins: readonly MintBurnCoinFlow[]): MintBurnCoinsAggregate24h {
  // /flows passes `summaryData?.coins ?? []`; an empty cohort means no coin was
  // read — missing evidence, not a complete observed zero.
  if (coins.length === 0) {
    return {
      mintVolumeUsd: 0,
      burnVolumeUsd: 0,
      mintCompleteness: "unknown",
      burnCompleteness: "unknown",
      mintClassificationCompleteness: "unknown",
      burnClassificationCompleteness: "unknown",
      unresolvedMintEventCount: 0,
      unresolvedBurnEventCount: 0,
      scanComplete: false,
      unpricedMintEventCount: 0,
      unpricedBurnEventCount: 0,
      net: sumMintBurnSignedNets([]),
      has24hActivity: null,
      direction: null,
    };
  }
  let mintVolumeUsd = 0;
  let burnVolumeUsd = 0;
  let unpricedMintEventCount = 0;
  let unpricedBurnEventCount = 0;
  let unresolvedMintEventCount = 0;
  let unresolvedBurnEventCount = 0;
  let knownNetUsd: number | null = 0;
  let has24hActivity: boolean | null = false;
  let activityUnknown = false;
  const mintSides: MintBurnValuationCompleteness[] = [];
  const burnSides: MintBurnValuationCompleteness[] = [];
  const mintClassificationSides: MintBurnValuationCompleteness[] = [];
  const burnClassificationSides: MintBurnValuationCompleteness[] = [];
  const nets: MintBurnSignedNetView[] = [];

  for (const coin of coins) {
    const valuation = resolveMintBurnValuation(coin.valuation?.window24h);
    const classification = coin.classification?.window24h;
    mintClassificationSides.push(classification?.mintCompleteness ?? "complete");
    burnClassificationSides.push(classification?.burnCompleteness ?? "complete");
    if (classification) {
      unresolvedMintEventCount += classification.unresolvedMintEventCount;
      unresolvedBurnEventCount += classification.unresolvedBurnEventCount;
      if (classification.completeness !== "complete") activityUnknown = true;
    }
    mintVolumeUsd += coin.mintVolume24hUsd;
    burnVolumeUsd += coin.burnVolume24hUsd;
    unpricedMintEventCount += valuation.unpricedMintEventCount;
    unpricedBurnEventCount += valuation.unpricedBurnEventCount;
    mintSides.push(valuation.mintCompleteness);
    burnSides.push(valuation.burnCompleteness);
    nets.push(resolveCoinNetFlow(coin, "24h"));
    // A partial coin publishes no signed net; its known subtotals still bound the aggregate range.
    const coinKnownNetUsd = coin.netFlow24hUsd
      ?? (coin.has24hActivity !== null && coin.coverage?.windows?.window24h.complete !== false && valuation.completeness === "partial" ? coin.mintVolume24hUsd - coin.burnVolume24hUsd : null);
    knownNetUsd = knownNetUsd == null || coinKnownNetUsd == null ? null : knownNetUsd + coinKnownNetUsd;
    const activity = inferHas24hActivity(coin);
    if (activity === null) activityUnknown = true;
    if (coin.coverage?.windows?.window24h.complete === false) activityUnknown = true;
    if (activity) has24hActivity = true;
    else if (activity === null && has24hActivity === false) has24hActivity = null;
  }

  const summed = sumMintBurnSignedNets(nets);
  const mintCompleteness = combineMintBurnValuationCompleteness(...mintSides);
  const burnCompleteness = combineMintBurnValuationCompleteness(...burnSides);
  // The aggregate bound uses the same per-side range as the direction, so the two never disagree.
  const bound = !activityUnknown && summed.valueUsd == null && summed.completeness === "partial" && knownNetUsd != null
    ? mintBurnSignedNetBound(knownNetUsd, { mintCompleteness, burnCompleteness })
    : null;
  const net: MintBurnSignedNetView = bound
    ? {
        ...summed,
        bound,
        note: describeMintBurnSignedNetBound(bound, describeUnpricedEvents({ unpricedMintEventCount, unpricedBurnEventCount })),
      }
    : summed;
  let direction: NetFlowDirection24h | null;
  if (activityUnknown) {
    direction = null;
  } else if (knownNetUsd != null && has24hActivity !== null) {
    direction = provenNetFlowDirection24h({
      knownNetUsd,
      has24hActivity,
      valuation: { mintCompleteness, burnCompleteness },
    });
  } else {
    direction = has24hActivity === false ? "inactive" : null;
  }

  return {
    mintVolumeUsd,
    burnVolumeUsd,
    mintCompleteness,
    burnCompleteness,
    mintClassificationCompleteness: combineMintBurnValuationCompleteness(...mintClassificationSides),
    burnClassificationCompleteness: combineMintBurnValuationCompleteness(...burnClassificationSides),
    unresolvedMintEventCount,
    unresolvedBurnEventCount,
    scanComplete: coins.every((coin) => hasCompleteCoinScan(coin, "24h")),
    unpricedMintEventCount,
    unpricedBurnEventCount,
    net,
    has24hActivity,
    direction,
  };
}
