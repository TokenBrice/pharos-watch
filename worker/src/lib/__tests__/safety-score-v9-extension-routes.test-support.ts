import type { ExitRouteObservation } from "@shared/types/exit-route";

export function dexRouteObservation(
  observedAt: number,
  overrides: Pick<ExitRouteObservation, "routeId" | "output"> & Partial<ExitRouteObservation>,
): ExitRouteObservation {
  return {
    routeFamily: "dex-amm",
    scope: { kind: "chain-contract", chain: "ethereum", contractOrPoolId: "pool", protocol: "curve" },
    requestedNotionalUsd: 1_000_000,
    settlementHorizonSec: 300,
    maxCostBps: 200,
    executableUsd: 900_000,
    completionRatio: 0.9,
    evidenceKind: "reserve-based-amm-simulation",
    confidence: "high",
    scoreEligible: true,
    observedAt,
    freshnessSeconds: 0,
    commonModeKeys: ["chain:ethereum", "protocol:curve"],
    ...overrides,
  };
}
