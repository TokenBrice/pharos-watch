import { describe, expect, it } from "vitest";
import {
  DEX_ROUTE_SOURCE_CAPABILITIES,
  buildP4DexExitRouteObservations,
  validateExitRouteCapacityCurve,
} from "../p4-exit-route-capacity";

describe("P4 DEX exit route observations", () => {
  it("uses retained orderbook depth at its measured 2% bound", () => {
    const result = buildP4DexExitRouteObservations({
      stablecoinId: "usdc-circle",
      observedAt: 1_720_000_000,
      retainedPools: [
        {
          poolId: "orderbook:coinbase:usdc-circle",
          project: "coinbase",
          chain: "orderbook",
          tvlUsd: 4_000_000,
          symbol: "USDC / ORDERBOOK-USD",
          poolType: "orderbook",
          source: "cg_tickers",
          extra: {
            orderbookDepthUsd: 750_000,
            measurement: { synthetic: true },
          },
        },
      ],
    });

    expect(result.coverage).toMatchObject({
      status: "populated",
      observationCount: 1,
      scoreEligibleObservationCount: 0,
      evidenceCounts: { "direct-orderbook-depth": 1 },
    });
    expect(result.observations[0]).toMatchObject({
      routeFamily: "dex-orderbook",
      requestedNotionalUsd: 1_000_000,
      maxCostBps: 200,
      executableUsd: 750_000,
      completionRatio: 0.75,
      output: { kind: "fiat", currency: "USD" },
      evidenceKind: "direct-orderbook-depth",
      confidence: "medium",
      scoreEligible: false,
    });
    expect(result.observations[0]!.capacityCurve).toHaveLength(4);
    expect(validateExitRouteCapacityCurve(result.observations[0]!.capacityCurve!)).toEqual([]);
  });

  it("reports shaped Curve evidence as non-executable instead of inferring depth from TVL", () => {
    const result = buildP4DexExitRouteObservations({
      stablecoinId: "usdc-circle",
      observedAt: 1_720_000_000,
      retainedPools: [
        {
          poolId: "ethereum:0xcurve",
          project: "curve",
          chain: "Ethereum",
          tvlUsd: 20_000_000,
          symbol: "USDC / USDT / DAI",
          poolType: "curve-stableswap",
          source: "dl",
          extra: {
            amplificationCoefficient: 2_000,
            balanceDetails: [
              { symbol: "USDC", balancePct: 40, isTracked: true },
              { symbol: "USDT", balancePct: 30, isTracked: true },
              { symbol: "DAI", balancePct: 30, isTracked: true },
            ],
            measurement: { synthetic: false },
          },
        },
      ],
    });

    expect(result.observations).toEqual([]);
    expect(result.coverage).toMatchObject({
      status: "unsupported",
      observationCount: 0,
      unsupportedPoolCount: 1,
      unsupportedReasons: {
        "nonExecutableEvidence:curve-stableswap-shaped": 1,
      },
    });
  });

  it("rejects curves that regress as the cost bound increases", () => {
    expect(
      validateExitRouteCapacityCurve([
        { requestedNotionalUsd: 1_000_000, maxCostBps: 100, executableUsd: 500_000, completionRatio: 0.5 },
        { requestedNotionalUsd: 1_000_000, maxCostBps: 200, executableUsd: 400_000, completionRatio: 0.4 },
      ]),
    ).toEqual(expect.arrayContaining(["cost-executable-decreased:1000000", "cost-completion-decreased:1000000"]));
  });

  it("documents that retained AMM inputs cannot support exact reserve simulation", () => {
    const orderbook = DEX_ROUTE_SOURCE_CAPABILITIES.find(
      (capability) => capability.id === "cg-tickers-orderbook-depth-2pct",
    );
    const curve = DEX_ROUTE_SOURCE_CAPABILITIES.find((capability) => capability.id === "curve-stableswap-shaped");
    const concentrated = DEX_ROUTE_SOURCE_CAPABILITIES.find((capability) => capability.id === "direct-api-amm-shaped");

    expect(orderbook).toMatchObject({
      outputEvidenceKind: "direct-orderbook-depth",
      confidence: "medium",
      outputKinds: ["fiat"],
      commonModeKeyKinds: ["venue", "protocol", "pool", "fiat"],
      scoreEligible: false,
    });
    expect(curve).toMatchObject({
      exactBalancesOrReserves: "partial",
      poolInvariantParameters: "partial",
      outputEvidenceKind: "generic-tvl-proxy",
    });
    expect(concentrated).toMatchObject({
      exactBalancesOrReserves: "partial",
      poolInvariantParameters: "absent",
      outputEvidenceKind: "generic-tvl-proxy",
    });
  });
});
