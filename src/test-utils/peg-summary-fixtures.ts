import type { PegSummaryCoin } from "@shared/types";

/** Canonical Worker peg-summary coin for view-model and table tests (AP-1 contract). */
export function makePegSummaryCoin(overrides: Partial<PegSummaryCoin> = {}): PegSummaryCoin {
  return {
    id: "usdc-circle",
    symbol: "USDC",
    name: "USD Coin",
    pegType: "peggedUSD",
    pegCurrency: "USD",
    governance: "centralized",
    currentDeviationBps: 0,
    pegReference: { valueUsd: 1, source: "median", contributorCount: 5, asOf: 1_700_000_000 },
    pegScore: 95,
    pegPct: 100,
    severityScore: 0,
    spreadPenalty: 0,
    eventCount: 0,
    worstDeviationBps: null,
    activeDepeg: false,
    lastEventAt: null,
    trackingSpanDays: 365,
    methodologyVersion: "test",
    ...overrides,
  };
}
