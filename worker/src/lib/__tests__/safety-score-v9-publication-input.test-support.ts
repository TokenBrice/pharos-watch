import type { ReportCardsFixedInputDraft } from "../../test-helpers/report-cards-fixed-input";

/** Synthetic input rows only; each suite owns its capture identity and reserve evidence. */
export function makePublicationPegRow(
  asset: { id: string; symbol: string; name: string },
  observedAtSec: number,
): ReportCardsFixedInputDraft["pegDataById"][string] {
  return {
    ...asset,
    pegType: "peggedUSD",
    pegCurrency: "USD",
    governance: "centralized",
    currentDeviationBps: 1,
    pegScore: 99,
    priceSource: "fixture-price",
    priceObservedAt: observedAtSec,
    pegPct: 99,
    severityScore: 0,
    spreadPenalty: 0,
    eventCount: 0,
    worstDeviationBps: 1,
    activeDepeg: false,
    lastEventAt: null,
    trackingSpanDays: 365,
    methodologyVersion: "peg:fixture-v1",
  };
}

export function makePublicationDexRow(
  observedAtSec: number,
): ReportCardsFixedInputDraft["dexLiqMap"][string] {
  return {
    liquidityScore: 12,
    concentrationHhi: 0.5,
    poolCount: 1,
    chainCount: 1,
    coverageClass: "primary",
    coverageConfidence: 1,
    liquidityEvidenceClass: "measured",
    hasMeasuredLiquidityEvidence: true,
    effectiveTvlUsd: 1_000_000,
    balanceMeasuredTvlUsd: 1_000_000,
    organicMeasuredTvlUsd: 1_000_000,
    exitRouteObservations: [],
    methodologyVersion: "dex:fixture-v1",
    updatedAt: observedAtSec,
  };
}
