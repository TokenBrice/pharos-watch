import { getRedemptionBackstopConfig, type RedemptionBackstopConfig } from "@shared/lib/redemption-backstops";
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

/**
 * The redemption-backstop registry is a module singleton shared by every suite in
 * the run, so a test that edits a config must restore each touched key — including
 * keys that were absent before the edit.
 */
export function withRedemptionBackstopConfig<T>(
  stablecoinId: string,
  overrides: Partial<RedemptionBackstopConfig>,
  run: (config: RedemptionBackstopConfig) => T,
): T {
  const config = getRedemptionBackstopConfig(stablecoinId);
  if (!config) throw new Error(`Missing redemption config fixture for ${stablecoinId}`);
  const mutable = config as unknown as Record<string, unknown>;
  const restore = Object.keys(overrides).map((key) => ({
    key,
    present: Object.prototype.hasOwnProperty.call(mutable, key),
    value: mutable[key],
  }));
  Object.assign(mutable, overrides);
  try {
    return run(config);
  } finally {
    for (const { key, present, value } of restore) {
      if (present) mutable[key] = value;
      else delete mutable[key];
    }
  }
}
