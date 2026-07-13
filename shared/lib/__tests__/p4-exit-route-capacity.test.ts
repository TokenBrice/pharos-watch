import { describe, expect, it } from "vitest";
import { ExitRouteObservationCoverageSchema } from "@shared/types/market";
import {
  DEX_ROUTE_SOURCE_CAPABILITIES,
  P4_AMM_MODELED_TVL_MAX_RATIO,
  P4_AMM_MODELED_TVL_MIN_RATIO,
  buildP4DexExitRouteObservations,
  isDexExitRouteCoverageComplete,
  validateExitRouteCapacityCurve,
} from "../p4-exit-route-capacity";

describe("P4 DEX exit route observations", () => {
  it("rejects internally inconsistent producer coverage counts", () => {
    const coverage = {
      status: "populated",
      capabilityMatrixVersion: "test-v1",
      retainedPoolCount: 1,
      observationCount: 0,
      scoreEligibleObservationCount: 0,
      scoreEligiblePoolCount: 1,
      unsupportedPoolCount: 0,
      evidenceCounts: {},
      unsupportedReasons: {},
    };

    expect(ExitRouteObservationCoverageSchema.safeParse(coverage).success).toBe(false);
    expect(
      ExitRouteObservationCoverageSchema.safeParse({
        ...coverage,
        scoreEligiblePoolCount: 0,
        scoreEligibleObservationCount: 1,
      }).success,
    ).toBe(false);
    expect(
      ExitRouteObservationCoverageSchema.safeParse({
        ...coverage,
        scoreEligiblePoolCount: 0,
        unsupportedPoolCount: 2,
      }).success,
    ).toBe(false);
  });
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

  it("does not infer complete pool coverage from multiple observations emitted by one exact pool", () => {
    const result = buildP4DexExitRouteObservations({
      stablecoinId: "usdc-circle",
      observedAt: 1_720_000_000,
      retainedPools: [
        {
          poolId: "ethereum:0x0000000000000000000000000000000000000001",
          project: "balancer",
          chain: "ethereum",
          tvlUsd: 3_000_000,
          symbol: "USDC / USDT / DAI",
          poolType: "balancer-weighted",
          source: "direct_api",
          extra: {
            ammExecutionModel: {
              source: "balancer",
              invariant: "weighted-constant-mean",
              trackedTokenIndex: 0,
              feeRate: 0.001,
              tokens: [
                {
                  address: "0x0000000000000000000000000000000000000011",
                  symbol: "USDC",
                  decimals: 6,
                  balance: 1_000_000,
                  referencePriceUsd: 1,
                  referencePriceSource: "tracked-market",
                  trackedAssetId: "usdc-circle",
                  weight: 0.34,
                },
                {
                  address: "0x0000000000000000000000000000000000000012",
                  symbol: "USDT",
                  decimals: 6,
                  balance: 1_000_000,
                  referencePriceUsd: 1,
                  referencePriceSource: "tracked-market",
                  trackedAssetId: "usdt-tether",
                  weight: 0.33,
                },
                {
                  address: "0x0000000000000000000000000000000000000013",
                  symbol: "DAI",
                  decimals: 18,
                  balance: 1_000_000,
                  referencePriceUsd: 1,
                  referencePriceSource: "tracked-market",
                  trackedAssetId: "dai-makerdao",
                  weight: 0.33,
                },
              ],
            },
          },
        },
        {
          poolId: "orderbook:coinbase:usdc-circle",
          project: "coinbase",
          chain: "orderbook",
          tvlUsd: 1_000_000,
          symbol: "USDC / USD",
          poolType: "orderbook",
          source: "cg_tickers",
          extra: { orderbookDepthUsd: 500_000 },
        },
      ],
    });

    expect(result.coverage).toMatchObject({
      retainedPoolCount: 2,
      scoreEligibleObservationCount: 2,
      scoreEligiblePoolCount: 1,
      unsupportedPoolCount: 0,
    });
    expect(isDexExitRouteCoverageComplete(result.coverage)).toBe(false);
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

  it("simulates a Raydium constant-product exit from exact retained reserves", () => {
    const result = buildP4DexExitRouteObservations({
      stablecoinId: "usdc-circle",
      observedAt: 1_720_000_000,
      retainedPools: [
        {
          poolId: "solana:raydium-pool",
          project: "raydium",
          chain: "solana",
          tvlUsd: 10_000_000,
          symbol: "USDC / USDT",
          poolType: "raydium-amm",
          source: "direct_api",
          extra: {
            ammExecutionModel: {
              source: "raydium",
              invariant: "constant-product",
              trackedTokenIndex: 0,
              feeRate: 0.003,
              tokens: [
                {
                  address: "UsdcMint",
                  symbol: "USDC",
                  decimals: 6,
                  balance: 5_000_000,
                  referencePriceUsd: 1,
                  referencePriceSource: "tracked-market",
                  trackedAssetId: "usdc-circle",
                },
                {
                  address: "UsdtMint",
                  symbol: "USDT",
                  decimals: 6,
                  balance: 5_000_000,
                  referencePriceUsd: 1,
                  referencePriceSource: "tracked-market",
                  trackedAssetId: "usdt-tether",
                },
              ],
            },
          },
        },
      ],
    });

    expect(result.coverage).toMatchObject({
      status: "populated",
      observationCount: 1,
      scoreEligibleObservationCount: 1,
      unsupportedPoolCount: 0,
      evidenceCounts: { "reserve-based-amm-simulation": 1 },
    });
    expect(result.observations[0]).toMatchObject({
      evidenceKind: "reserve-based-amm-simulation",
      confidence: "high",
      scoreEligible: true,
      output: {
        kind: "tracked-stablecoin",
        trackedAssetIds: ["usdt-tether"],
        assetKeys: ["solana:UsdtMint"],
      },
    });
    expect(result.observations[0]!.executableUsd).toBeGreaterThan(80_000);
    expect(result.observations[0]!.executableUsd).toBeLessThan(90_000);
    expect(result.observations[0]!.commonModeKeys).toContain("token:solana:UsdtMint");
    expect(result.observations[0]!.routeId).toBe("dex:usdc-circle:direct-api:solana%3Araydium-pool:solana%3AUsdtMint");
    expect(validateExitRouteCapacityCurve(result.observations[0]!.capacityCurve!)).toEqual([]);
  });

  it("keeps case-distinct Solana pool and mint identities in distinct routes", () => {
    const buildPool = (poolId: string, outputMint: string) => ({
      poolId,
      project: "raydium",
      chain: "Solana",
      tvlUsd: 4_000_000,
      symbol: "USDC / USDT",
      poolType: "raydium-amm",
      source: "direct_api" as const,
      extra: {
        ammExecutionModel: {
          source: "raydium" as const,
          invariant: "constant-product" as const,
          trackedTokenIndex: 0,
          feeRate: 0.0025,
          tokens: [
            {
              address: "TrackedMint",
              symbol: "USDC",
              decimals: 6,
              balance: 2_000_000,
              referencePriceUsd: 1,
              referencePriceSource: "tracked-market" as const,
              trackedAssetId: "usdc-circle",
            },
            {
              address: outputMint,
              symbol: "USDT",
              decimals: 6,
              balance: 2_000_000,
              referencePriceUsd: 1,
              referencePriceSource: "tracked-market" as const,
              trackedAssetId: "usdt-tether",
            },
          ],
        },
      },
    });
    const result = buildP4DexExitRouteObservations({
      stablecoinId: "usdc-circle",
      observedAt: 1_720_000_000,
      retainedPools: [buildPool("solana:PoolCase", "OutputMint"), buildPool("solana:poolCase", "outputMint")],
    });

    expect(result.observations).toHaveLength(2);
    expect(new Set(result.observations.map((observation) => observation.routeId)).size).toBe(2);
    expect(result.observations.map((observation) => observation.routeId)).toEqual([
      "dex:usdc-circle:direct-api:solana%3APoolCase:solana%3AOutputMint",
      "dex:usdc-circle:direct-api:solana%3ApoolCase:solana%3AoutputMint",
    ]);
    expect(result.observations[0]!.commonModeKeys).toContain("pool:solana:PoolCase");
    expect(result.observations[1]!.commonModeKeys).toContain("pool:solana:poolCase");
  });

  it("collapses EVM checksum variants when validating duplicate model tokens", () => {
    const result = buildP4DexExitRouteObservations({
      stablecoinId: "usdc-circle",
      observedAt: 1_720_000_000,
      retainedPools: [
        {
          poolId: "ethereum:0x0000000000000000000000000000000000000001",
          project: "balancer",
          chain: "Ethereum",
          tvlUsd: 2_000_000,
          symbol: "USDC / USDC",
          poolType: "balancer-weighted",
          source: "direct_api",
          extra: {
            ammExecutionModel: {
              source: "balancer",
              invariant: "weighted-constant-mean",
              trackedTokenIndex: 0,
              feeRate: 0.001,
              tokens: [
                {
                  address: "0xAbCd000000000000000000000000000000000001",
                  symbol: "USDC",
                  decimals: 6,
                  balance: 1_000_000,
                  referencePriceUsd: 1,
                  referencePriceSource: "tracked-market",
                  trackedAssetId: "usdc-circle",
                  weight: 0.5,
                },
                {
                  address: "0xaBcD000000000000000000000000000000000001",
                  symbol: "USDC",
                  decimals: 6,
                  balance: 1_000_000,
                  referencePriceUsd: 1,
                  referencePriceSource: "tracked-market",
                  trackedAssetId: "usdc-circle",
                  weight: 0.5,
                },
              ],
            },
          },
        },
      ],
    });

    expect(result.observations).toEqual([]);
    expect(result.coverage).toMatchObject({
      retainedPoolCount: 1,
      unsupportedPoolCount: 1,
      unsupportedReasons: { "invalidExecutionModel:duplicate-token-identity": 1 },
    });
  });

  it("requires the exact model input to identify the scored stablecoin", () => {
    const result = buildP4DexExitRouteObservations({
      stablecoinId: "usdc-circle",
      observedAt: 1_720_000_000,
      retainedPools: [
        {
          poolId: "solana:TrackedMismatchPool",
          project: "raydium",
          chain: "solana",
          tvlUsd: 4_000_000,
          symbol: "USDT / USDC",
          poolType: "raydium-amm",
          source: "direct_api",
          extra: {
            ammExecutionModel: {
              source: "raydium",
              invariant: "constant-product",
              trackedTokenIndex: 0,
              feeRate: 0.0025,
              tokens: [
                {
                  address: "UsdtMint",
                  symbol: "USDT",
                  decimals: 6,
                  balance: 2_000_000,
                  referencePriceUsd: 1,
                  referencePriceSource: "tracked-market",
                  trackedAssetId: "usdt-tether",
                },
                {
                  address: "UsdcMint",
                  symbol: "USDC",
                  decimals: 6,
                  balance: 2_000_000,
                  referencePriceUsd: 1,
                  referencePriceSource: "tracked-market",
                  trackedAssetId: "usdc-circle",
                },
              ],
            },
          },
        },
      ],
    });

    expect(result.observations).toEqual([]);
    expect(result.coverage).toMatchObject({
      retainedPoolCount: 1,
      unsupportedPoolCount: 1,
      unsupportedReasons: { "invalidExecutionModel:tracked-input-stablecoin-mismatch": 1 },
    });
  });

  it("accepts coherent model TVL at the named bounds and quarantines mismatches", () => {
    const buildPool = (poolId: string, retainedTvlUsd: number) => ({
      poolId,
      project: "raydium",
      chain: "solana",
      tvlUsd: retainedTvlUsd,
      symbol: "USDC / USDT",
      poolType: "raydium-amm",
      source: "direct_api" as const,
      extra: {
        ammExecutionModel: {
          source: "raydium" as const,
          invariant: "constant-product" as const,
          trackedTokenIndex: 0,
          feeRate: 0.0025,
          tokens: [
            {
              address: "UsdcMint",
              symbol: "USDC",
              decimals: 6,
              balance: 1_000_000,
              referencePriceUsd: 1,
              referencePriceSource: "tracked-market" as const,
              trackedAssetId: "usdc-circle",
            },
            {
              address: "UsdtMint",
              symbol: "USDT",
              decimals: 6,
              balance: 1_000_000,
              referencePriceUsd: 1,
              referencePriceSource: "tracked-market" as const,
              trackedAssetId: "usdt-tether",
            },
          ],
        },
      },
    });
    const result = buildP4DexExitRouteObservations({
      stablecoinId: "usdc-circle",
      observedAt: 1_720_000_000,
      retainedPools: [
        buildPool("solana:LowerBound", 2_000_000 / P4_AMM_MODELED_TVL_MIN_RATIO),
        buildPool("solana:UpperBound", 2_000_000 / P4_AMM_MODELED_TVL_MAX_RATIO),
        buildPool("solana:TooLarge", 5_000_000),
        buildPool("solana:TooSmall", 500_000),
      ],
    });

    expect(result.observations).toHaveLength(2);
    expect(result.coverage).toMatchObject({
      retainedPoolCount: 4,
      unsupportedPoolCount: 2,
      unsupportedReasons: {
        "invalidExecutionModel:modeled-tvl-below-retained-bound": 1,
        "invalidExecutionModel:modeled-tvl-above-retained-bound": 1,
      },
    });
  });

  it("values Balancer weighted output with that token's own reference price", () => {
    const result = buildP4DexExitRouteObservations({
      stablecoinId: "usdc-circle",
      observedAt: 1_720_000_000,
      retainedPools: [
        {
          poolId: "ethereum:0x0000000000000000000000000000000000000001",
          project: "balancer",
          chain: "ethereum",
          tvlUsd: 10_000_000,
          symbol: "USDC / WETH",
          poolType: "balancer-weighted",
          source: "direct_api",
          extra: {
            ammExecutionModel: {
              source: "balancer",
              invariant: "weighted-constant-mean",
              trackedTokenIndex: 0,
              feeRate: 0.003,
              tokens: [
                {
                  address: "0x0000000000000000000000000000000000000002",
                  symbol: "USDC",
                  decimals: 6,
                  balance: 8_000_000,
                  referencePriceUsd: 1,
                  referencePriceSource: "source-token-usd",
                  trackedAssetId: "usdc-circle",
                  weight: 0.8,
                },
                {
                  address: "0x0000000000000000000000000000000000000003",
                  symbol: "WETH",
                  decimals: 18,
                  balance: 2_000,
                  referencePriceUsd: 1_000,
                  referencePriceSource: "source-token-usd",
                  weight: 0.2,
                },
              ],
            },
          },
        },
      ],
    });

    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({
      output: {
        kind: "collateral",
        assetKeys: ["ethereum:0x0000000000000000000000000000000000000003"],
        basketWeights: [{ symbol: "WETH", weight: 1 }],
      },
      scoreEligible: true,
    });
    expect(result.observations[0]!.executableUsd).toBeGreaterThan(0);
    expect(result.observations[0]!.executableUsd).toBeLessThan(1_000_000);
  });

  it("quarantines incomplete weighted models instead of falling back to TVL", () => {
    const result = buildP4DexExitRouteObservations({
      stablecoinId: "usdc-circle",
      observedAt: 1_720_000_000,
      retainedPools: [
        {
          poolId: "ethereum:0xpool",
          project: "balancer",
          chain: "ethereum",
          tvlUsd: 100_000_000,
          symbol: "USDC / WETH",
          poolType: "balancer-weighted",
          source: "direct_api",
          extra: {
            ammExecutionModel: {
              source: "balancer",
              invariant: "weighted-constant-mean",
              trackedTokenIndex: 0,
              feeRate: 0.003,
              tokens: [
                {
                  address: "0xusdc",
                  symbol: "USDC",
                  decimals: 6,
                  balance: 80_000_000,
                  referencePriceUsd: 1,
                  referencePriceSource: "tracked-market",
                  trackedAssetId: "usdc-circle",
                  weight: 0.8,
                },
                {
                  address: "0xweth",
                  symbol: "WETH",
                  decimals: 18,
                  balance: 20_000,
                  referencePriceUsd: 1_000,
                  referencePriceSource: "source-token-usd",
                },
              ],
            },
          },
        },
      ],
    });

    expect(result.observations).toEqual([]);
    expect(result.coverage).toMatchObject({
      status: "unsupported",
      unsupportedPoolCount: 1,
      unsupportedReasons: { "invalidExecutionModel:invalid-weights": 1 },
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
    const raydium = DEX_ROUTE_SOURCE_CAPABILITIES.find(
      (capability) => capability.id === "raydium-constant-product-exact",
    );

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
    expect(raydium).toMatchObject({
      exactBalancesOrReserves: "exact",
      poolInvariantParameters: "exact",
      outputEvidenceKind: "reserve-based-amm-simulation",
      scoreEligible: true,
    });
  });
});
