import type { DexExitRouteObservation } from "@shared/types/market";

export function makeCoinbaseRouteObservation(): DexExitRouteObservation {
  return {
    routeId: "dex:usdc:cg-tickers:coinbase",
    routeFamily: "dex-orderbook",
    scope: { kind: "venue", venue: "coinbase", protocol: "coinbase" },
    requestedNotionalUsd: 1_000_000,
    settlementHorizonSec: 300,
    maxCostBps: 200,
    executableUsd: 500_000,
    completionRatio: 0.5,
    output: { kind: "fiat", currency: "USD" },
    evidenceKind: "direct-orderbook-depth",
    confidence: "medium",
    scoreEligible: false,
    observedAt: 1_720_000_000,
    freshnessSeconds: 0,
    commonModeKeys: ["protocol:coinbase", "fiat:usd"],
    capacityCurve: [
      {
        requestedNotionalUsd: 1_000_000,
        maxCostBps: 200,
        executableUsd: 500_000,
        completionRatio: 0.5,
      },
    ],
  };
}
