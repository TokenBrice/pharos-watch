import { describe, expect, it } from "vitest";
import { ExitRouteObservationCoverageSchema } from "@shared/types/market";
import {
  DEX_MEASURED_CAPACITY_NOTIONALS_USD,
  DEX_MEASURED_ADAPTER_PROFILE_IDS,
  DEX_MEASURED_MAX_COST_BPS,
  type DexMeasuredExecutionPublicProfile,
} from "@shared/types/measured-execution";
import {
  DEX_ROUTE_SOURCE_CAPABILITIES,
  P4_AMM_MODELED_TVL_MAX_RATIO,
  P4_AMM_MODELED_TVL_MIN_RATIO,
  buildP4DexExitRouteObservations,
  isDexExitRouteCoverageComplete,
  isDexExitRouteCoverageWithinRouteBudget,
  validateExitRouteCapacityCurve,
} from "../p4-exit-route-capacity";
import { makeMeasuredProfile } from "./measured-execution.test-support";

describe("P4 DEX exit route observations", () => {
  function measuredProfile(quotedAt: number): DexMeasuredExecutionPublicProfile {
    return makeMeasuredProfile(quotedAt);
  }

  function aerodromeMeasuredProfile(quotedAt: number): DexMeasuredExecutionPublicProfile {
    const profile = measuredProfile(quotedAt);
    if (!profile.poolProvenance) throw new Error("Measured fixture must retain pool provenance");
    return {
      ...profile,
      adapterProfileId: "aerodrome-slipstream-quoter-v2",
      protocol: "aerodrome-slipstream",
      chain: "base",
      poolId: `base:${profile.poolProvenance.resolvedPoolAddress}`,
    };
  }

  function uniswapV4MeasuredProfile(quotedAt: number): DexMeasuredExecutionPublicProfile {
    const { poolProvenance: _poolProvenance, ...profile } = measuredProfile(quotedAt);
    const poolId = `0x${"12".repeat(32)}`;
    return {
      ...profile,
      adapterProfileId: "uniswap-v4-hook-free-quoter-v1",
      protocol: "uniswap-v4",
      poolId: `ethereum:${poolId}`,
      tickSpacing: 1,
      hookAddress: "0x0000000000000000000000000000000000000000",
      executionEndpoint: {
        address: "0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203",
        codeHash: "0x06de58fa119c5deaa7a667fb92d3894e25d9160e62fb82c8d86d43b47eefe441",
      },
      uniswapV4PoolProvenance: {
        blockNumber: profile.blockNumber,
        poolId,
        poolManagerAddress: "0x000000000004444c5dc75cb358380d2e3de08a90",
        poolManagerCodeHash: "0x785f1014552b7ce7d5fb7d0c970ca60edee94fd00425d7ca21609acac7ce1293",
        stateViewAddress: "0x7ffe42c4a5deea5b0fec41c94c136cf115597227",
        stateViewCodeHash: "0xd7947778589cf4aac9a092a4451292a2056380941635ab7006d3c691d8dfd878",
        sqrtPriceX96: "79228162514264337593543950336",
        tick: 0,
        protocolFee: 0,
        lpFee: 100,
        liquidity: "1000000",
      },
    };
  }

  function curveMeasuredProfile(quotedAt: number): DexMeasuredExecutionPublicProfile {
    const poolAddress = "0x313698667d7fdd6789a9bc70821309ff891e729a" as const;
    const crvUsd = "0xf939e0a03fb07f59a73314e73794be0e57ac1b4e" as const;
    const wbtc = "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599" as const;
    const base = measuredProfile(quotedAt);
    return {
      ...base,
      adapterProfileId: "curve-cryptoswap-get-dy-v1",
      protocol: "curve",
      poolId: `ethereum:${poolAddress}`,
      poolTokenAddresses: [crvUsd, wbtc],
      tokenIn: {
        address: crvUsd,
        symbol: "crvUSD",
        decimals: 18,
        referencePriceUsd: 1,
        trackedAssetId: "crvusd-curve",
      },
      tokenOut: {
        address: wbtc,
        symbol: "WBTC",
        decimals: 8,
        referencePriceUsd: 65_000,
      },
      feePips: undefined,
      executionEndpoint: {
        address: poolAddress,
        codeHash: `0x${"ab".repeat(32)}`,
      },
      poolProvenance: {
        factoryAddress: "0x5555555555555555555555555555555555555555",
        factoryCodeHash: `0x${"cd".repeat(32)}`,
        resolvedPoolAddress: poolAddress,
      },
    };
  }

  function curveStableSwapMeasuredProfiles(
    quotedAt: number,
    successfulCycles: number,
  ): DexMeasuredExecutionPublicProfile[] {
    const poolAddress = "0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7" as const;
    const tokens = [
      {
        address: "0x6b175474e89094c44da98b954eedeac495271d0f" as const,
        symbol: "DAI",
        decimals: 18,
        trackedAssetId: "dai-makerdao",
      },
      {
        address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as const,
        symbol: "USDC",
        decimals: 6,
        trackedAssetId: "usdc-circle",
      },
      {
        address: "0xdac17f958d2ee523a2206206994597c13d831ec7" as const,
        symbol: "USDT",
        decimals: 6,
        trackedAssetId: "usdt-tether",
      },
    ];
    return tokens.slice(0, 2).map((outputToken, outputIndex) => {
      const base = measuredProfile(quotedAt);
      const capacityCurve = DEX_MEASURED_CAPACITY_NOTIONALS_USD.map((requestedNotionalUsd) => ({
        requestedNotionalUsd,
        maxCostBps: DEX_MEASURED_MAX_COST_BPS,
        executableUsd: requestedNotionalUsd,
        completionRatio: 1,
        executionCostBps: outputIndex === 0 ? 55 : 46,
      }));
      return {
        ...base,
        targetId: `curve-3pool-usdt-${outputToken.symbol.toLowerCase()}`,
        targetGenerationId: "curve-target-generation",
        quoteGenerationId: "curve-quote-generation",
        adapterProfileId: DEX_MEASURED_ADAPTER_PROFILE_IDS.curveStableSwap,
        protocol: "curve",
        poolId: `ethereum:${poolAddress}`,
        poolTokenAddresses: tokens.map((token) => token.address),
        tokenIn: {
          address: tokens[2]!.address,
          symbol: tokens[2]!.symbol,
          decimals: tokens[2]!.decimals,
          referencePriceUsd: 0.9992518040104241,
          trackedAssetId: tokens[2]!.trackedAssetId,
        },
        tokenOut: {
          address: outputToken.address,
          symbol: outputToken.symbol,
          decimals: outputToken.decimals,
          referencePriceUsd: 1,
          trackedAssetId: outputToken.trackedAssetId,
        },
        feePips: undefined,
        retainedTvlUsdAtQuote: 160_047_206,
        retainedPoolPriceUsdAtQuote: 0.9992518040104241,
        blockNumber: 25_601_051,
        executionEndpoint: {
          address: poolAddress,
          codeHash: "0x954a1e212c557c85043985931498ffa3e2fcbe7dfe9cd61513f36eb47d6f4dfc",
        },
        poolProvenance: undefined,
        registryProvenance: {
          registryAddress: "0x90e00ace148ca3b23ac1bc8c240c2a7dd9c2d7f5",
          registryCodeHash: "0x13d7cfcf1cef4bf310fa544567a427771c9be2c16bbf2c6be845d3d5f4cc5f22",
          registeredPoolAddress: poolAddress,
          lpTokenAddress: "0x6c3f90f043a72fa612cbac8115ee7e52bde6e490",
          poolTokenAddresses: tokens.map((token) => token.address),
        },
        capacityCurve,
        observationHistory: {
          completeProducerCycleCount: successfulCycles,
          successfulObservationCount: successfulCycles,
          consecutiveSuccessCount: successfulCycles,
          observationWindowStartedAt: quotedAt - 3_000,
          observationWindowEndedAt: quotedAt + 10,
          latestOperationalFailureAt: null,
          conservativeStatistic: "pointwise-minimum" as const,
          conservativeCapacityCurve: capacityCurve,
        },
      };
    });
  }

  function curveThreePoolAmmModel() {
    return {
      source: "curve" as const,
      invariant: "stableswap" as const,
      trackedTokenIndex: 2,
      feeRate: 0.001,
      amplification: 4_000 / 9,
      tokens: [
        {
          address: "0x6b175474e89094c44da98b954eedeac495271d0f",
          symbol: "DAI",
          decimals: 18,
          balance: 28_348_143,
          referencePriceUsd: 1,
          referencePriceSource: "source-token-usd" as const,
          trackedAssetId: "dai-makerdao",
        },
        {
          address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          symbol: "USDC",
          decimals: 6,
          balance: 28_486_107,
          referencePriceUsd: 1,
          referencePriceSource: "source-token-usd" as const,
          trackedAssetId: "usdc-circle",
        },
        {
          address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
          symbol: "USDT",
          decimals: 6,
          balance: 103_289_773,
          referencePriceUsd: 0.9992518040104241,
          referencePriceSource: "source-token-usd" as const,
          trackedAssetId: "usdt-tether",
        },
      ],
    };
  }

  function curveStableSwapNgMeasuredProfile(
    quotedAt: number,
    completeCycles: number,
    successfulCycles = completeCycles,
  ): DexMeasuredExecutionPublicProfile {
    const poolAddress = "0xc061caa073f3d95f80f8e5428d32d2d76f5e1622" as const;
    const usdg = "0xe343167631d89b6ffc58b88d6b7fb0228795491d" as const;
    const usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as const;
    const base = measuredProfile(quotedAt);
    const capacityCurve = [
      { requestedNotionalUsd: 100_000, executableUsd: 100_000, executionCostBps: 1.0633 },
      { requestedNotionalUsd: 1_000_000, executableUsd: 1_000_000, executionCostBps: 1.362 },
      { requestedNotionalUsd: 10_000_000, executableUsd: 10_000_000, executionCostBps: 64.2536 },
      { requestedNotionalUsd: 25_000_000, executableUsd: 10_325_100 },
    ].map((point) => ({
      ...point,
      maxCostBps: DEX_MEASURED_MAX_COST_BPS,
      completionRatio: point.executableUsd / point.requestedNotionalUsd,
    }));
    return {
      ...base,
      targetId: "curve-stableswap-ng-usdg-usdc",
      targetGenerationId: "curve-ng-target-generation",
      quoteGenerationId: "curve-ng-quote-generation",
      adapterProfileId: DEX_MEASURED_ADAPTER_PROFILE_IDS.curveStableSwapNg,
      protocol: "curve",
      poolId: `ethereum:${poolAddress}`,
      poolTokenAddresses: [usdg, usdc],
      tokenIn: {
        address: usdg,
        symbol: "USDG",
        decimals: 6,
        referencePriceUsd: 1,
        trackedAssetId: "usdg-paxos",
      },
      tokenOut: {
        address: usdc,
        symbol: "USDC",
        decimals: 6,
        referencePriceUsd: 1,
        trackedAssetId: "usdc-circle",
      },
      feePips: undefined,
      retainedTvlUsdAtQuote: 20_501_133,
      retainedPoolPriceUsdAtQuote: 1,
      blockNumber: 25_601_359,
      executionEndpoint: {
        address: poolAddress,
        codeHash: "0x1c7b77a94bb42408ab6d5cfd76223f0c794db9b119bb6035db91d8b09da65512",
      },
      poolProvenance: undefined,
      stableSwapNgFactoryProvenance: {
        blockNumber: 25_601_359,
        blockHash: `0x${"12".repeat(32)}`,
        blockCommitment: "finalized",
        factoryAddress: "0x6a8cbed756804b16e05e741edabd5cb544ae21bf",
        factoryCodeHash: "0xb78c1b32cd364260f3fa497ccc7e98c73cdc26bdae2d3635e763ee8b59a1d6fd",
        poolIndex: 563,
        registeredPoolAddress: poolAddress,
        poolTokenAddresses: [usdg, usdc],
      },
      capacityCurve,
      observationHistory: {
        completeProducerCycleCount: completeCycles,
        successfulObservationCount: successfulCycles,
        consecutiveSuccessCount: successfulCycles,
        observationWindowStartedAt: quotedAt - 3_000,
        observationWindowEndedAt: quotedAt + 10,
        latestOperationalFailureAt: null,
        conservativeStatistic: "pointwise-minimum",
        conservativeCapacityCurve: capacityCurve,
      },
    };
  }

  function curveDusdStableSwapNgMeasuredProfile(
    quotedAt: number,
    completeCycles: number,
    successfulCycles = completeCycles,
  ): DexMeasuredExecutionPublicProfile {
    const profile = curveStableSwapNgMeasuredProfile(quotedAt, completeCycles, successfulCycles);
    const poolAddress = "0x32e616f4f17d43f9a5cd9be0e294727187064cb3" as const;
    const usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as const;
    const dusd = "0x1e33e98af620f1d563fcd3cfd3c75ace841204ef" as const;
    const capacityCurve = [
      { requestedNotionalUsd: 100_000, executableUsd: 24_900 },
      { requestedNotionalUsd: 1_000_000, executableUsd: 24_900 },
      { requestedNotionalUsd: 10_000_000, executableUsd: 24_900 },
      { requestedNotionalUsd: 25_000_000, executableUsd: 24_900 },
    ].map((point) => ({
      ...point,
      maxCostBps: DEX_MEASURED_MAX_COST_BPS,
      completionRatio: point.executableUsd / point.requestedNotionalUsd,
    }));
    return {
      ...profile,
      targetId: "curve-stableswap-ng-dusd-usdc",
      poolId: `ethereum:${poolAddress}`,
      poolTokenAddresses: [usdc, dusd],
      tokenIn: {
        address: dusd,
        symbol: "DUSD",
        decimals: 18,
        referencePriceUsd: 1.0331154651675625,
        trackedAssetId: "dusd-dialectic",
      },
      tokenOut: {
        address: usdc,
        symbol: "USDC",
        decimals: 6,
        referencePriceUsd: 1,
        trackedAssetId: "usdc-circle",
      },
      retainedTvlUsdAtQuote: 27_477.27,
      retainedPoolPriceUsdAtQuote: 1.0331154651675625,
      blockNumber: 25_638_735,
      executionEndpoint: {
        address: poolAddress,
        codeHash: "0x1fb319d2b11164fe6584bf44ed640436ce07baa68c65e5b3b2338aa4ad8b6ac7",
      },
      stableSwapNgFactoryProvenance: {
        blockNumber: 25_638_735,
        blockHash: `0x${"34".repeat(32)}`,
        blockCommitment: "finalized",
        factoryAddress: "0x6a8cbed756804b16e05e741edabd5cb544ae21bf",
        factoryCodeHash: "0xb78c1b32cd364260f3fa497ccc7e98c73cdc26bdae2d3635e763ee8b59a1d6fd",
        poolIndex: 580,
        registeredPoolAddress: poolAddress,
        poolTokenAddresses: [usdc, dusd],
      },
      capacityCurve,
      observationHistory: {
        ...profile.observationHistory!,
        conservativeCapacityCurve: capacityCurve,
      },
    };
  }

  function curveStableSwapNgAmmModel() {
    return {
      source: "curve" as const,
      invariant: "stableswap" as const,
      trackedTokenIndex: 0,
      feeRate: 0.001,
      amplification: 1_500,
      tokens: [
        {
          address: "0xe343167631d89b6ffc58b88d6b7fb0228795491d",
          symbol: "USDG",
          decimals: 6,
          balance: 10_297_747.249493,
          referencePriceUsd: 1,
          referencePriceSource: "source-token-usd" as const,
          trackedAssetId: "usdg-paxos",
        },
        {
          address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          symbol: "USDC",
          decimals: 6,
          balance: 10_203_386.233391,
          referencePriceUsd: 1,
          referencePriceSource: "source-token-usd" as const,
          trackedAssetId: "usdc-circle",
        },
      ],
    };
  }

  function withObservationHistory(
    profile: DexMeasuredExecutionPublicProfile,
    successfulObservationCount: number,
    conservativeExecutableUsd: number,
  ): DexMeasuredExecutionPublicProfile {
    const conservativeCapacityCurve = profile.capacityCurve.map((point) => {
      const executableUsd = Math.min(point.executableUsd, conservativeExecutableUsd);
      return {
        ...point,
        executableUsd,
        completionRatio: executableUsd / point.requestedNotionalUsd,
      };
    });
    return {
      ...profile,
      observationHistory: {
        completeProducerCycleCount: successfulObservationCount,
        successfulObservationCount,
        consecutiveSuccessCount: successfulObservationCount,
        observationWindowStartedAt: profile.quotedAt - 1_000,
        observationWindowEndedAt: profile.quotedAt + 10,
        latestOperationalFailureAt: null,
        conservativeStatistic: "pointwise-minimum",
        conservativeCapacityCurve,
      },
    };
  }

  it("falls back Solana and Tron pools to shaped evidence outside the strict denominator", () => {
    // Liquidity Score v6 Phase 3: the native measured lanes are removed, so
    // Raydium/Orca/SunSwap pools carry no measured profiles and no
    // measured-execution gates. They must resolve to their shaped source
    // capabilities and must not hold quote-missing/target-unresolved rows in
    // the strict completeness denominator beside a measured EVM route.
    const observedAt = 1_752_560_000;
    const physicalPoolId = "ethereum:0x3333333333333333333333333333333333333333";
    const result = buildP4DexExitRouteObservations({
      stablecoinId: "usdc-circle",
      observedAt,
      retainedPools: [
        {
          poolId: physicalPoolId,
          project: "uniswap-v3",
          chain: "ethereum",
          tvlUsd: 2_000_000,
          symbol: "USDC-USDT",
          poolType: "uniswap-v3",
          source: "dl",
          extra: {
            measuredExecution: measuredProfile(observedAt - 60),
            measuredExecutionPhysicalPoolId: physicalPoolId,
          },
        },
        {
          poolId: "solana:Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE",
          project: "orca",
          chain: "Solana",
          tvlUsd: 2_000_000,
          symbol: "USDC / USDT",
          poolType: "orca-whirlpool",
          source: "direct_api",
        },
        {
          poolId: "solana:raydium-clmm-pool",
          project: "raydium",
          chain: "Solana",
          tvlUsd: 1_500_000,
          symbol: "USDC / USDT",
          poolType: "raydium-clmm",
          source: "direct_api",
        },
        {
          poolId: "tron:TFGDbUyP8xez44C76fin3bn3Ss6jugoUwJ",
          project: "sunswap-v2",
          chain: "Tron",
          tvlUsd: 2_000_000,
          symbol: "USDT / WTRX",
          poolType: "sunswap-v2",
          source: "dl",
        },
      ],
    });

    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({
      evidenceKind: "measured-executable-depth",
      scoreEligible: true,
    });
    expect(result.coverage).toMatchObject({
      retainedPoolCount: 4,
      scoreEligibleCapabilityPoolCount: 1,
      scoreEligiblePoolCount: 1,
      unsupportedPoolCount: 3,
      unsupportedReasons: {
        "nonExecutableEvidence:direct-api-amm-shaped": 2,
        "nonExecutableEvidence:defillama-pool-shaped": 1,
      },
    });
    expect(isDexExitRouteCoverageComplete(result.coverage)).toBe(true);
  });

  it("routes a retained DL UUID through its independently bound physical CL pool", () => {
    const observedAt = 1_752_560_000;
    const physicalPoolId = "ethereum:0x3333333333333333333333333333333333333333";
    const result = buildP4DexExitRouteObservations({
      stablecoinId: "usdc-circle",
      observedAt,
      retainedPools: [
        {
          poolId: "defillama-yields-uuid",
          project: "uniswap-v3",
          chain: "ethereum",
          tvlUsd: 2_000_000,
          symbol: "USDC-USDT",
          poolType: "uniswap-v3",
          source: "dl",
          extra: {
            measuredExecution: measuredProfile(observedAt - 60),
            measuredExecutionPhysicalPoolId: physicalPoolId,
          },
        },
      ],
    });

    expect(result.coverage).toMatchObject({
      capabilityMatrixVersion: "p4a.9",
      retainedPoolCount: 1,
      scoreEligibleCapabilityPoolCount: 1,
      scoreEligiblePoolCount: 1,
      unsupportedPoolCount: 0,
    });
    expect(isDexExitRouteCoverageComplete(result.coverage)).toBe(true);
    expect(result.observations[0]).toMatchObject({
      scope: { kind: "chain-contract", contractOrPoolId: physicalPoolId },
      observedAt: observedAt - 60,
      freshnessSeconds: 60,
      output: { kind: "tracked-stablecoin", trackedAssetIds: ["usdt-tether"] },
      confidence: "medium",
    });
    expect(result.observations[0]?.routeId).toContain("3333333333333333333333333333333333333333");
  });

  it("uses the pointwise-minimum curve and requires two successful cycles for high confidence", () => {
    const observedAt = 1_752_560_000;
    const physicalPoolId = "ethereum:0x3333333333333333333333333333333333333333";
    const profile = withObservationHistory(measuredProfile(observedAt - 60), 2, 750_000);
    profile.observationHistory = {
      ...profile.observationHistory!,
      completeProducerCycleCount: 3,
      consecutiveSuccessCount: 0,
      latestOperationalFailureAt: profile.observationHistory!.observationWindowEndedAt,
    };
    const result = buildP4DexExitRouteObservations({
      stablecoinId: "usdc-circle",
      observedAt,
      retainedPools: [
        {
          poolId: "defillama-yields-uuid",
          project: "uniswap-v3",
          chain: "ethereum",
          tvlUsd: 2_000_000,
          symbol: "USDC-USDT",
          poolType: "uniswap-v3",
          source: "dl",
          extra: {
            measuredExecution: profile,
            measuredExecutionPhysicalPoolId: physicalPoolId,
          },
        },
      ],
    });

    expect(result.observations[0]).toMatchObject({
      routeFamily: "dex-amm",
      confidence: "high",
      executableUsd: 750_000,
      observationHistory: {
        completeProducerCycleCount: 3,
        successfulObservationCount: 2,
        consecutiveSuccessCount: 0,
        conservativeStatistic: "pointwise-minimum",
      },
    });
    expect(result.observations[0]?.capacityCurve).toEqual(profile.observationHistory?.conservativeCapacityCurve);

    const immature = withObservationHistory(measuredProfile(observedAt - 60), 1, 750_000);
    const immatureResult = buildP4DexExitRouteObservations({
      stablecoinId: "usdc-circle",
      observedAt,
      retainedPools: [
        {
          poolId: "defillama-yields-uuid",
          project: "uniswap-v3",
          chain: "ethereum",
          tvlUsd: 2_000_000,
          symbol: "USDC-USDT",
          poolType: "uniswap-v3",
          source: "dl",
          extra: {
            measuredExecution: immature,
            measuredExecutionPhysicalPoolId: physicalPoolId,
          },
        },
      ],
    });
    expect(immatureResult.observations[0]?.confidence).toBe("medium");
  });

  it("accepts the active Curve CryptoSwap measured adapter in the existing exact capability matrix", () => {
    const observedAt = 1_752_560_000;
    const profile = curveMeasuredProfile(observedAt - 60);
    const result = buildP4DexExitRouteObservations({
      stablecoinId: "crvusd-curve",
      observedAt,
      retainedPools: [
        {
          poolId: "defillama-yields-uuid",
          project: "curve",
          chain: "ethereum",
          tvlUsd: 2_000_000,
          symbol: "CRVUSD-WBTC",
          poolType: "curve-cryptoswap",
          source: "dl",
          extra: {
            measuredExecution: profile,
            measuredExecutionPhysicalPoolId: profile.poolId,
          },
        },
      ],
    });

    expect(result.coverage).toMatchObject({
      capabilityMatrixVersion: "p4a.9",
      retainedPoolCount: 1,
      scoreEligibleCapabilityPoolCount: 1,
      scoreEligiblePoolCount: 1,
      unsupportedPoolCount: 0,
      evidenceCounts: { "measured-executable-depth": 1 },
    });
    expect(isDexExitRouteCoverageComplete(result.coverage)).toBe(true);
    expect(result.observations[0]).toMatchObject({
      scope: { kind: "chain-contract", contractOrPoolId: profile.poolId },
      output: {
        kind: "collateral",
        assetKeys: ["ethereum:0x2260fac5e5542a773aa44fbcfedf7c193bc2c599"],
      },
      evidenceKind: "measured-executable-depth",
      scoreEligible: true,
    });
  });

  it("accepts the active hook-free Ethereum Uniswap V4 adapter", () => {
    const observedAt = 1_752_560_000;
    const profile = uniswapV4MeasuredProfile(observedAt - 60);
    const result = buildP4DexExitRouteObservations({
      stablecoinId: "usdc-circle",
      observedAt,
      retainedPools: [{
        poolId: "defillama-yields-uuid",
        project: "uniswap-v4",
        chain: "ethereum",
        tvlUsd: 2_000_000,
        symbol: "USDC-USDT",
        poolType: "uniswap-v4",
        source: "dl",
        extra: {
          measuredExecution: profile,
          measuredExecutionPhysicalPoolId: profile.poolId,
        },
      }],
    });

    expect(result.coverage).toMatchObject({
      capabilityMatrixVersion: "p4a.9",
      scoreEligibleCapabilityPoolCount: 1,
      scoreEligiblePoolCount: 1,
      unsupportedPoolCount: 0,
    });
    expect(result.observations[0]).toMatchObject({
      adapterProfileId: "uniswap-v4-hook-free-quoter-v1",
      evidenceKind: "measured-executable-depth",
      scoreEligible: true,
    });
  });

  it.each(["aerodrome", "aerodrome-slipstream"])(
    "accepts the active Base Aerodrome Slipstream adapter on retained %s rows",
    (project) => {
      const observedAt = 1_752_560_000;
      const profile = aerodromeMeasuredProfile(observedAt - 60);
      const result = buildP4DexExitRouteObservations({
        stablecoinId: "usdc-circle",
        observedAt,
        retainedPools: [{
          poolId: "defillama-yields-uuid",
          project,
          chain: "base",
          tvlUsd: 2_000_000,
          symbol: "USDC-USDT",
          poolType: "aerodrome-slipstream",
          source: "dl",
          extra: {
            measuredExecution: profile,
            measuredExecutionPhysicalPoolId: profile.poolId,
          },
        }],
      });

      expect(result.observations[0]).toMatchObject({
        adapterProfileId: "aerodrome-slipstream-quoter-v2",
        evidenceKind: "measured-executable-depth",
        scoreEligible: true,
      });
      expect(result.coverage).toMatchObject({
        scoreEligibleCapabilityPoolCount: 1,
        scoreEligiblePoolCount: 1,
        unsupportedPoolCount: 0,
      });
      expect(isDexExitRouteCoverageComplete(result.coverage)).toBe(true);
    },
  );

  it("does not broaden the Slipstream alias to an unrelated retained protocol", () => {
    const observedAt = 1_752_560_000;
    const profile = aerodromeMeasuredProfile(observedAt - 60);
    const result = buildP4DexExitRouteObservations({
      stablecoinId: "usdc-circle",
      observedAt,
      retainedPools: [{
        poolId: "defillama-yields-uuid",
        project: "velodrome",
        chain: "base",
        tvlUsd: 2_000_000,
        symbol: "USDC-USDT",
        poolType: "aerodrome-slipstream",
        source: "dl",
        extra: {
          measuredExecution: profile,
          measuredExecutionPhysicalPoolId: profile.poolId,
        },
      }],
    });

    expect(result.observations).toEqual([]);
    expect(result.coverage.unsupportedReasons).toEqual({
      "invalidMeasuredExecution:pool-identity-mismatch": 1,
    });
  });

  it("keeps the 3pool reserve model score-facing until the atomic packet matures", () => {
    const observedAt = 1_784_877_551;
    const physicalPoolId = "ethereum:0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7";
    const run = (successfulCycles: number, quoteAgeSec = 60) =>
      buildP4DexExitRouteObservations({
        stablecoinId: "usdt-tether",
        observedAt,
        retainedPools: [{
          poolId: "25171c4c-1877-449a-9f88-45a9f153ee31",
          project: "curve",
          chain: "ethereum",
          tvlUsd: 160_047_206,
          symbol: "DAI-USDC-USDT",
          poolType: "curve-stableswap-high-a",
          source: "dl",
          extra: {
            ammExecutionModel: curveThreePoolAmmModel(),
            measuredExecutions: curveStableSwapMeasuredProfiles(
              observedAt - quoteAgeSec,
              successfulCycles,
            ),
            measuredExecutionPhysicalPoolId: physicalPoolId,
          },
        }],
      });

    const immature = run(2);
    expect(immature.coverage).toMatchObject({
      retainedPoolCount: 1,
      observationCount: 2,
      scoreEligibleObservationCount: 2,
      scoreEligibleCapabilityPoolCount: 1,
      scoreEligiblePoolCount: 1,
      unsupportedPoolCount: 0,
      evidenceCounts: { "reserve-based-amm-simulation": 2 },
    });
    expect(immature.observations.map((observation) => observation.output)).toEqual([
      expect.objectContaining({ kind: "tracked-stablecoin", trackedAssetIds: ["dai-makerdao"] }),
      expect.objectContaining({ kind: "tracked-stablecoin", trackedAssetIds: ["usdc-circle"] }),
    ]);
    expect(immature.observations.every(
      (observation) =>
        observation.evidenceKind === "reserve-based-amm-simulation" &&
        observation.adapterProfileId === undefined,
    )).toBe(true);
    expect(isDexExitRouteCoverageComplete(immature.coverage)).toBe(true);

    const mature = run(3);
    expect(mature.observations).toHaveLength(2);
    expect(mature.observations.every(
      (observation) =>
        observation.confidence === "high" &&
        observation.adapterProfileId === DEX_MEASURED_ADAPTER_PROFILE_IDS.curveStableSwap,
    )).toBe(true);
    const matureCapacityCurve = mature.observations[1]?.capacityCurve ?? [];
    expect(matureCapacityCurve[matureCapacityCurve.length - 1]).toMatchObject({
      requestedNotionalUsd: 25_000_000,
      executableUsd: 25_000_000,
      executionCostBps: 46,
    });
    const retainedMature = buildP4DexExitRouteObservations({
      stablecoinId: "usdt-tether",
      observedAt,
      retainedPools: [{
        poolId: physicalPoolId,
        project: "curve",
        chain: "ethereum",
        tvlUsd: 160_047_206,
        symbol: "USDT-DAI/USDC",
        poolType: "curve-stableswap-measured-retained",
        source: "dl",
        extra: {
          measuredExecutions: curveStableSwapMeasuredProfiles(observedAt - 60, 3),
          measuredExecutionPhysicalPoolId: physicalPoolId,
        },
      }],
    });
    expect(retainedMature.observations).toHaveLength(2);
    expect(retainedMature.observations.every(
      (observation) => observation.evidenceKind === "measured-executable-depth",
    )).toBe(true);
    expect(run(3, 10_799).observations).toHaveLength(2);
    const expired = run(3, 10_801);
    expect(expired.observations).toEqual([]);
    expect(expired.coverage.unsupportedReasons["invalidMeasuredExecution:stale-profile"]).toBe(2);

    const mixedProfiles = curveStableSwapMeasuredProfiles(observedAt - 60, 3);
    mixedProfiles[1]!.observationHistory = {
      ...mixedProfiles[1]!.observationHistory!,
      completeProducerCycleCount: 2,
      successfulObservationCount: 2,
      consecutiveSuccessCount: 2,
    };
    const mixed = buildP4DexExitRouteObservations({
      stablecoinId: "usdt-tether",
      observedAt,
      retainedPools: [{
        poolId: "25171c4c-1877-449a-9f88-45a9f153ee31",
        project: "curve",
        chain: "ethereum",
        tvlUsd: 160_047_206,
        symbol: "DAI-USDC-USDT",
        poolType: "curve-stableswap-high-a",
        source: "dl",
        extra: {
          ammExecutionModel: curveThreePoolAmmModel(),
          measuredExecutions: mixedProfiles,
          measuredExecutionPhysicalPoolId: physicalPoolId,
        },
      }],
    });
    expect(mixed.observations.every(
      (observation) => observation.evidenceKind === "reserve-based-amm-simulation",
    )).toBe(true);
  });

  it("keeps USDG reserves score-facing until the exact NG profile reaches 3/3 maturity", () => {
    const observedAt = 1_784_879_259;
    const physicalPoolId = "ethereum:0xc061caa073f3d95f80f8e5428d32d2d76f5e1622";
    const run = (
      completeCycles: number,
      successfulCycles = completeCycles,
      includeReserveModel = true,
    ) =>
      buildP4DexExitRouteObservations({
        stablecoinId: "usdg-paxos",
        observedAt,
        retainedPools: [{
          poolId: "curve-usdg-usdc-defillama-uuid",
          project: "curve",
          chain: "ethereum",
          tvlUsd: 20_501_133,
          symbol: "USDG-USDC",
          poolType: "curve-stableswap-high-a",
          source: "dl",
          extra: {
            ...(includeReserveModel ? { ammExecutionModel: curveStableSwapNgAmmModel() } : {}),
            measuredExecution: curveStableSwapNgMeasuredProfile(
              observedAt - 60,
              completeCycles,
              successfulCycles,
            ),
            measuredExecutionPhysicalPoolId: physicalPoolId,
          },
        }],
      });

    const incomplete = run(2);
    expect(incomplete.observations).toHaveLength(1);
    expect(incomplete.observations[0]).toMatchObject({
      evidenceKind: "reserve-based-amm-simulation",
      confidence: "high",
      output: { kind: "tracked-stablecoin", trackedAssetIds: ["usdc-circle"] },
    });
    expect(incomplete.observations[0]?.adapterProfileId).toBeUndefined();
    expect(isDexExitRouteCoverageComplete(incomplete.coverage)).toBe(true);

    const unsuccessful = run(3, 2);
    expect(unsuccessful.observations[0]?.evidenceKind).toBe("reserve-based-amm-simulation");

    const mature = run(3);
    expect(mature.coverage).toMatchObject({
      capabilityMatrixVersion: "p4a.9",
      retainedPoolCount: 1,
      observationCount: 1,
      scoreEligibleCapabilityPoolCount: 1,
      scoreEligiblePoolCount: 1,
      unsupportedPoolCount: 0,
      evidenceCounts: { "measured-executable-depth": 1 },
    });
    expect(mature.observations[0]).toMatchObject({
      evidenceKind: "measured-executable-depth",
      adapterProfileId: DEX_MEASURED_ADAPTER_PROFILE_IDS.curveStableSwapNg,
      confidence: "high",
      scope: { kind: "chain-contract", contractOrPoolId: physicalPoolId },
    });
    const capacityCurve = mature.observations[0]?.capacityCurve;
    expect(capacityCurve?.[capacityCurve.length - 1]).toMatchObject({
      requestedNotionalUsd: 25_000_000,
      executableUsd: 10_325_100,
    });

    const retainedMature = run(3, 3, false);
    expect(retainedMature.observations[0]?.evidenceKind).toBe("measured-executable-depth");

    const immatureWithoutReserves = run(2, 2, false);
    expect(immatureWithoutReserves.observations).toEqual([]);
    expect(immatureWithoutReserves.coverage.unsupportedReasons.immatureAtomicMeasuredPacket).toBe(1);
  });

  it("rejects malformed USDG NG provenance instead of masking semantic drift with reserves", () => {
    const observedAt = 1_784_879_259;
    const profile = curveStableSwapNgMeasuredProfile(observedAt - 60, 3);
    profile.stableSwapNgFactoryProvenance!.blockHash = "0x1234";
    const result = buildP4DexExitRouteObservations({
      stablecoinId: "usdg-paxos",
      observedAt,
      retainedPools: [{
        poolId: "curve-usdg-usdc-defillama-uuid",
        project: "curve",
        chain: "ethereum",
        tvlUsd: 20_501_133,
        symbol: "USDG-USDC",
        poolType: "curve-stableswap-high-a",
        source: "dl",
        extra: {
          ammExecutionModel: curveStableSwapNgAmmModel(),
          measuredExecution: profile,
          measuredExecutionPhysicalPoolId:
            "ethereum:0xc061caa073f3d95f80f8e5428d32d2d76f5e1622",
        },
      }],
    });

    expect(result.observations).toEqual([]);
    expect(result.coverage.unsupportedReasons["invalidMeasuredExecution:invalid-profile-schema"]).toBe(1);
    expect(
      result.coverage.unsupportedReasons["invalidMeasuredExecution:physical-pool-provenance-mismatch"],
    ).toBe(1);
  });

  it("admits reviewed DUSD NG get_dy evidence as score-eligible measured exit coverage", () => {
    const observedAt = 1_784_879_259;
    const physicalPoolId = "ethereum:0x32e616f4f17d43f9a5cd9be0e294727187064cb3";
    const result = buildP4DexExitRouteObservations({
      stablecoinId: "dusd-dialectic",
      observedAt,
      retainedPools: [{
        poolId: "curve-dusd-usdc-defillama-uuid",
        project: "curve",
        chain: "ethereum",
        tvlUsd: 27_477.27,
        symbol: "DUSD-USDC",
        poolType: "curve-stableswap-high-a",
        source: "dl",
        extra: {
          measuredExecution: curveDusdStableSwapNgMeasuredProfile(observedAt - 60, 3),
          measuredExecutionPhysicalPoolId: physicalPoolId,
        },
      }],
    });

    expect(result.coverage).toMatchObject({
      capabilityMatrixVersion: "p4a.9",
      retainedPoolCount: 1,
      observationCount: 1,
      scoreEligibleCapabilityPoolCount: 1,
      scoreEligiblePoolCount: 1,
      unsupportedPoolCount: 0,
      evidenceCounts: { "measured-executable-depth": 1 },
    });
    expect(result.observations[0]).toMatchObject({
      evidenceKind: "measured-executable-depth",
      adapterProfileId: DEX_MEASURED_ADAPTER_PROFILE_IDS.curveStableSwapNg,
      confidence: "high",
      executableUsd: 24_900,
      output: { kind: "tracked-stablecoin", trackedAssetIds: ["usdc-circle"] },
      scope: { kind: "chain-contract", contractOrPoolId: physicalPoolId },
    });
    expect(isDexExitRouteCoverageComplete(result.coverage)).toBe(true);
  });

  it("rejects a partial or provenance-drifted 3pool packet instead of masking it with reserves", () => {
    const observedAt = 1_784_877_551;
    const profiles = curveStableSwapMeasuredProfiles(observedAt - 60, 3);
    const pool = {
      poolId: "25171c4c-1877-449a-9f88-45a9f153ee31",
      project: "curve",
      chain: "ethereum",
      tvlUsd: 160_047_206,
      symbol: "DAI-USDC-USDT",
      poolType: "curve-stableswap-high-a",
      source: "dl" as const,
      extra: {
        ammExecutionModel: curveThreePoolAmmModel(),
        measuredExecutions: [profiles[0]!],
        measuredExecutionPhysicalPoolId: "ethereum:0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7",
      },
    };
    const partial = buildP4DexExitRouteObservations({
      stablecoinId: "usdt-tether",
      observedAt,
      retainedPools: [pool],
    });
    expect(partial.observations).toEqual([]);
    expect(partial.coverage.unsupportedReasons.invalidAtomicMeasuredPacket).toBe(1);

    profiles[0]!.registryProvenance!.registryCodeHash = `0x${"11".repeat(32)}`;
    const drifted = buildP4DexExitRouteObservations({
      stablecoinId: "usdt-tether",
      observedAt,
      retainedPools: [{
        ...pool,
        extra: { ...pool.extra, measuredExecutions: profiles },
      }],
    });
    expect(drifted.observations).toEqual([]);
    expect(
      drifted.coverage.unsupportedReasons["invalidMeasuredExecution:physical-pool-provenance-mismatch"],
    ).toBe(1);

    const reserveFallback = buildP4DexExitRouteObservations({
      stablecoinId: "usdt-tether",
      observedAt,
      retainedPools: [{
        ...pool,
        extra: {
          ammExecutionModel: curveThreePoolAmmModel(),
          measuredExecutionPhysicalPoolId: pool.extra.measuredExecutionPhysicalPoolId,
        },
      }],
    });
    expect(reserveFallback.observations).toHaveLength(2);
    expect(reserveFallback.observations.every(
      (observation) => observation.evidenceKind === "reserve-based-amm-simulation",
    )).toBe(true);
  });

  it("keeps stale, conflicting, and marginal-failed measured profiles in the incomplete denominator", () => {
    const observedAt = 1_752_560_000;
    const cases = [
      {
        profile: measuredProfile(observedAt - 10_801),
        extra: {},
        reason: "invalidMeasuredExecution:stale-profile",
      },
      {
        profile: measuredProfile(observedAt - 60),
        extra: { ammExecutionModel: { source: "raydium" } },
        reason: "conflictingExecutionCapabilityEvidence",
      },
      {
        profile: { ...measuredProfile(observedAt - 60), marginalOutputRatio: 0.97 },
        extra: {},
        reason: "invalidMeasuredExecution:marginal-failure-with-positive-capacity",
      },
    ] as const;

    for (const testCase of cases) {
      const result = buildP4DexExitRouteObservations({
        stablecoinId: "usdc-circle",
        observedAt,
        retainedPools: [
          {
            poolId: "defillama-yields-uuid",
            project: "uniswap-v3",
            chain: "ethereum",
            tvlUsd: 2_000_000,
            symbol: "USDC-USDT",
            poolType: "uniswap-v3",
            source: "dl",
            extra: {
              measuredExecution: testCase.profile,
              measuredExecutionPhysicalPoolId: "ethereum:0x3333333333333333333333333333333333333333",
              ...(testCase.extra as object),
            },
          },
        ],
      });

      expect(result.coverage.scoreEligibleCapabilityPoolCount).toBe(1);
      expect(result.coverage.scoreEligiblePoolCount).toBe(0);
      expect(result.coverage.unsupportedReasons[testCase.reason]).toBeGreaterThan(0);
      expect(isDexExitRouteCoverageComplete(result.coverage)).toBe(false);
    }
  });
  it("requires an explicit capability denominator before production-shaped coverage can be complete", () => {
    const legacyProductionCoverage = {
      status: "populated" as const,
      capabilityMatrixVersion: "p4a.3",
      retainedPoolCount: 2_418,
      observationCount: 44,
      scoreEligibleObservationCount: 44,
      scoreEligiblePoolCount: 38,
      unsupportedPoolCount: 2_380,
      evidenceCounts: { "reserve-based-amm-simulation": 44 },
      unsupportedReasons: {
        "nonExecutableEvidence:defillama-pool-shaped": 1_449,
        "nonExecutableEvidence:curve-stableswap-shaped": 11,
        "nonExecutableEvidence:direct-api-amm-shaped": 653,
        "nonExecutableEvidence:discovery-pool-shaped": 267,
      },
    };

    // p4a.3 discarded exact-family gate reasons into the same shaped buckets
    // as generic rows, so no safe denominator can be reconstructed.
    expect(isDexExitRouteCoverageComplete(legacyProductionCoverage)).toBe(false);
    const explicitProductionCoverage = {
      ...legacyProductionCoverage,
      capabilityMatrixVersion: "p4a.9",
      scoreEligibleCapabilityPoolCount: 38,
    };
    expect(
      isDexExitRouteCoverageComplete({
        ...explicitProductionCoverage,
        capabilityMatrixVersion: "p4a.3",
      }),
    ).toBe(false);
    expect(
      isDexExitRouteCoverageComplete({
        ...explicitProductionCoverage,
        capabilityMatrixVersion: "p4a.6",
      }),
    ).toBe(false);
    expect(isDexExitRouteCoverageComplete(explicitProductionCoverage)).toBe(true);
    expect(
      isDexExitRouteCoverageComplete({
        ...explicitProductionCoverage,
        retainedPoolCount: 2_419,
        scoreEligibleCapabilityPoolCount: 39,
        unsupportedPoolCount: 2_381,
        unsupportedReasons: {
          ...legacyProductionCoverage.unsupportedReasons,
          "invalidExecutionModel:invalid-amplification": 1,
        },
      }),
    ).toBe(false);
  });

  it("excludes route-selection overflow from the budget-accounting denominator only", () => {
    // USD1-shaped surface: 283 capability pools, 24 selected and observed
    // (the full MAX_DEX_EXIT_ROUTE_OBSERVATIONS payload), 259 omitted solely by
    // the bounded route-selection budget.
    const overflowOnlyCoverage = {
      status: "populated" as const,
      capabilityMatrixVersion: "p4a.9",
      retainedPoolCount: 283,
      observationCount: 24,
      scoreEligibleObservationCount: 24,
      scoreEligiblePoolCount: 24,
      scoreEligibleCapabilityPoolCount: 283,
      unsupportedPoolCount: 259,
      evidenceCounts: { "measured-executable-depth": 24 },
      unsupportedReasons: { routeObservationPayloadOverflow: 259 },
    };
    expect(isDexExitRouteCoverageComplete(overflowOnlyCoverage)).toBe(false);
    expect(isDexExitRouteCoverageWithinRouteBudget(overflowOnlyCoverage)).toBe(true);

    // A genuine capability gate alongside overflow keeps both predicates false:
    // 12 capability pools, 2 overflow, only 4 observed of the 10 in budget.
    const gatedCoverage = {
      ...overflowOnlyCoverage,
      retainedPoolCount: 12,
      observationCount: 4,
      scoreEligibleObservationCount: 4,
      scoreEligiblePoolCount: 4,
      scoreEligibleCapabilityPoolCount: 12,
      unsupportedPoolCount: 8,
      unsupportedReasons: {
        routeObservationPayloadOverflow: 2,
        "executionCapabilityGate:measured-execution:quote-failed": 6,
      },
    };
    expect(isDexExitRouteCoverageComplete(gatedCoverage)).toBe(false);
    expect(isDexExitRouteCoverageWithinRouteBudget(gatedCoverage)).toBe(false);

    // Without overflow the budget predicate matches the strict one.
    const strictComplete = {
      ...overflowOnlyCoverage,
      retainedPoolCount: 10,
      observationCount: 10,
      scoreEligibleObservationCount: 10,
      scoreEligiblePoolCount: 10,
      scoreEligibleCapabilityPoolCount: 10,
      evidenceCounts: { "measured-executable-depth": 10 },
      unsupportedPoolCount: 0,
      unsupportedReasons: {},
    };
    expect(isDexExitRouteCoverageComplete(strictComplete)).toBe(true);
    expect(isDexExitRouteCoverageWithinRouteBudget(strictComplete)).toBe(true);

    // Degenerate all-overflow surface never certifies coverage.
    const allOverflow = {
      ...overflowOnlyCoverage,
      observationCount: 0,
      scoreEligibleObservationCount: 0,
      scoreEligiblePoolCount: 0,
      scoreEligibleCapabilityPoolCount: 273,
      unsupportedPoolCount: 283,
    };
    expect(isDexExitRouteCoverageWithinRouteBudget(allOverflow)).toBe(false);

    // Stale capability-matrix versions stay rejected.
    expect(
      isDexExitRouteCoverageWithinRouteBudget({ ...overflowOnlyCoverage, capabilityMatrixVersion: "p4a.3" }),
    ).toBe(false);
  });

  it("reads the route-overflow reason key the producer actually emits", () => {
    // Captured verbatim from a sync-dex-liquidity run for
    // usd1-world-liberty-financial: the payload-budget trim writes
    // `routeObservationPayloadOverflow`. Hand-written fixtures previously used
    // an invented key, so the carve-out could never fire on real coverage.
    const producerCoverage = {
      status: "populated" as const,
      capabilityMatrixVersion: "p4a.9",
      retainedPoolCount: 372,
      observationCount: 24,
      scoreEligibleObservationCount: 24,
      scoreEligiblePoolCount: 24,
      scoreEligibleCapabilityPoolCount: 277,
      unsupportedPoolCount: 348,
      evidenceCounts: { "reserve-based-amm-simulation": 17, "measured-executable-depth": 7 },
      unsupportedReasons: {
        "executionCapabilityGate:measured-execution:activation-pending": 2,
        "executionCapabilityGate:measured-execution:quote-failed": 8,
        "executionCapabilityGate:measured-execution:target-unresolved": 9,
        "executionCapabilityGate:measured-execution:quote-missing": 1,
        "executionCapabilityGate:measured-execution:stale-observation": 1,
        "executionCapabilityGate:raydium-amm:incomplete-exact-capture": 1,
        "nonExecutableEvidence:defillama-pool-shaped": 8,
        "nonExecutableEvidence:discovery-pool-shaped": 87,
        routeObservationPayloadOverflow: 231,
      },
    };
    expect(ExitRouteObservationCoverageSchema.safeParse(producerCoverage).success).toBe(true);
    // 9.2: ten score-eligible observations already fill the public payload
    // bound, so leftover construction/model gates and non-admitted quote
    // failures are not missing budgeted observations.
    expect(isDexExitRouteCoverageWithinRouteBudget(producerCoverage)).toBe(true);

    // Same surface with the gated pools cleared: the only unobserved
    // capability pools are payload-budget omissions, so budget accounting
    // certifies it. This assertion fails whenever the predicate reads a key
    // the producer does not emit.
    const gatesClearedCoverage = {
      ...producerCoverage,
      unsupportedReasons: {
        "nonExecutableEvidence:defillama-pool-shaped": 8,
        "nonExecutableEvidence:discovery-pool-shaped": 87,
        routeObservationPayloadOverflow: 253,
      },
    };
    expect(ExitRouteObservationCoverageSchema.safeParse(gatesClearedCoverage).success).toBe(true);
    expect(isDexExitRouteCoverageWithinRouteBudget(gatesClearedCoverage)).toBe(true);

    // Any other reason key stays in the completeness denominator, including
    // the `routeSelectionCapabilityOverflow` key that never shipped.
    for (const driftedKey of ["routeSelectionCapabilityOverflow", "routeSelectionBudgetOverflow"]) {
      expect(
        isDexExitRouteCoverageWithinRouteBudget({
          ...gatesClearedCoverage,
          unsupportedReasons: {
            "nonExecutableEvidence:defillama-pool-shaped": 8,
            "nonExecutableEvidence:discovery-pool-shaped": 87,
            [driftedKey]: 267,
          },
        }),
      ).toBe(false);
    }
  });

  it("carves rotating quote-budget deferrals out of route-budget accounting", () => {
    // Same producer surface, with the rotating Solana quote budget as the only
    // remaining gap: 3 targets deferred before any capability was exercised.
    const rotationDeferredCoverage = {
      status: "populated" as const,
      capabilityMatrixVersion: "p4a.9",
      retainedPoolCount: 372,
      observationCount: 24,
      scoreEligibleObservationCount: 24,
      scoreEligiblePoolCount: 24,
      scoreEligibleCapabilityPoolCount: 277,
      unsupportedPoolCount: 348,
      evidenceCounts: { "reserve-based-amm-simulation": 17, "measured-executable-depth": 7 },
      unsupportedReasons: {
        "executionCapabilityGate:measured-execution:budget-deferred": 3,
        "nonExecutableEvidence:defillama-pool-shaped": 8,
        "nonExecutableEvidence:discovery-pool-shaped": 87,
        routeObservationPayloadOverflow: 250,
      },
    };
    expect(ExitRouteObservationCoverageSchema.safeParse(rotationDeferredCoverage).success).toBe(true);
    expect(isDexExitRouteCoverageComplete(rotationDeferredCoverage)).toBe(false);
    expect(isDexExitRouteCoverageWithinRouteBudget(rotationDeferredCoverage)).toBe(true);

    // quote-failed on a payload-saturated surface is a leftover attempt, not a
    // missing budgeted observation. It still fails closed when the public
    // bound is not full (see gatedCoverage above, 4 of 10 observed).
    expect(
      isDexExitRouteCoverageWithinRouteBudget({
        ...rotationDeferredCoverage,
        unsupportedReasons: {
          "executionCapabilityGate:measured-execution:quote-failed": 3,
          "nonExecutableEvidence:defillama-pool-shaped": 8,
          "nonExecutableEvidence:discovery-pool-shaped": 87,
          routeObservationPayloadOverflow: 250,
        },
      }),
    ).toBe(true);
  });

  it("certifies live USDT/USDC/DAI/EURC budgeted surfaces and keeps crvUSD open", () => {
    const usdtShaped = {
      status: "populated" as const,
      capabilityMatrixVersion: "p4a.9",
      retainedPoolCount: 1307,
      observationCount: 24,
      scoreEligibleObservationCount: 24,
      scoreEligiblePoolCount: 24,
      scoreEligibleCapabilityPoolCount: 802,
      unsupportedPoolCount: 1283,
      evidenceCounts: { "measured-executable-depth": 24 },
      unsupportedReasons: {
        "executionCapabilityGate:constant-product-v2:incomplete-exact-capture": 13,
        "executionCapabilityGate:measured-execution:target-unresolved": 461,
        "executionCapabilityGate:measured-execution:quote-missing": 40,
        "executionCapabilityGate:curve-stableswap:exact-pool-join-unresolved": 6,
        "executionCapabilityGate:measured-execution:budget-deferred": 82,
        "executionCapabilityGate:curve-cryptoswap:unsupported-invariant": 5,
        "executionCapabilityGate:measured-execution:invalid-observation": 3,
        "executionCapabilityGate:curve-stableswap:rate-bearing-inputs": 5,
        "executionCapabilityGate:balancer-amm:paused-or-swap-disabled": 2,
        "executionCapabilityGate:balancer-amm:rate-bearing-inputs": 1,
        "executionCapabilityGate:measured-execution:activation-pending": 1,
        "nonExecutableEvidence:discovery-pool-shaped": 280,
        "nonExecutableEvidence:direct-api-amm-shaped": 1,
        "nonExecutableEvidence:defillama-pool-shaped": 224,
        invalidRetainedPool: 2,
        routeObservationPayloadOverflow: 157,
      },
    };
    expect(isDexExitRouteCoverageComplete(usdtShaped)).toBe(false);
    expect(isDexExitRouteCoverageWithinRouteBudget(usdtShaped)).toBe(true);

    const daiShaped = {
      status: "populated" as const,
      capabilityMatrixVersion: "p4a.9",
      retainedPoolCount: 119,
      observationCount: 24,
      scoreEligibleObservationCount: 24,
      scoreEligiblePoolCount: 24,
      scoreEligibleCapabilityPoolCount: 61,
      unsupportedPoolCount: 95,
      evidenceCounts: { "measured-executable-depth": 24 },
      unsupportedReasons: {
        "executionCapabilityGate:measured-execution:quote-missing": 4,
        "executionCapabilityGate:measured-execution:target-unresolved": 19,
        "executionCapabilityGate:balancer-amm:unsupported-invariant": 2,
        "nonExecutableEvidence:defillama-pool-shaped": 50,
        "nonExecutableEvidence:discovery-pool-shaped": 8,
        routeObservationPayloadOverflow: 12,
      },
    };
    expect(isDexExitRouteCoverageWithinRouteBudget(daiShaped)).toBe(true);

    const eurcShaped = {
      status: "populated" as const,
      capabilityMatrixVersion: "p4a.9",
      retainedPoolCount: 42,
      observationCount: 8,
      scoreEligibleObservationCount: 8,
      scoreEligiblePoolCount: 8,
      scoreEligibleCapabilityPoolCount: 34,
      unsupportedPoolCount: 34,
      evidenceCounts: { "measured-executable-depth": 8 },
      unsupportedReasons: {
        "executionCapabilityGate:measured-execution:target-unresolved": 11,
        "executionCapabilityGate:measured-execution:quote-missing": 5,
        "executionCapabilityGate:measured-execution:budget-deferred": 5,
        "executionCapabilityGate:curve-stableswap:rate-bearing-inputs": 1,
        "executionCapabilityGate:balancer-amm:rate-bearing-inputs": 1,
        "executionCapabilityGate:curve-cryptoswap:unsupported-invariant": 1,
        "nonExecutableEvidence:defillama-pool-shaped": 8,
        routeObservationPayloadOverflow: 2,
      },
    };
    expect(isDexExitRouteCoverageWithinRouteBudget(eurcShaped)).toBe(true);

    const crvusdShaped = {
      status: "populated" as const,
      capabilityMatrixVersion: "p4a.9",
      retainedPoolCount: 113,
      observationCount: 3,
      scoreEligibleObservationCount: 3,
      scoreEligiblePoolCount: 3,
      scoreEligibleCapabilityPoolCount: 50,
      unsupportedPoolCount: 110,
      evidenceCounts: { "measured-executable-depth": 3 },
      unsupportedReasons: {
        "invalidMeasuredExecution:physical-pool-provenance-mismatch": 8,
        "executionCapabilityGate:curve-cryptoswap:unsupported-invariant": 13,
        "executionCapabilityGate:curve-stableswap:rate-bearing-inputs": 1,
        "executionCapabilityGate:measured-execution:deployment-code-mismatch": 3,
        "nonExecutableEvidence:discovery-pool-shaped": 62,
        "nonExecutableEvidence:defillama-pool-shaped": 1,
        routeObservationPayloadOverflow: 22,
      },
    };
    expect(isDexExitRouteCoverageWithinRouteBudget(crvusdShaped)).toBe(false);
  });

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
        observationCount: 1,
        scoreEligibleObservationCount: 1,
        scoreEligibleCapabilityPoolCount: 0,
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

  it("counts exact pools rather than emitted observations or diagnostic orderbooks", () => {
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
    expect(result.coverage.scoreEligibleCapabilityPoolCount).toBe(1);
    expect(isDexExitRouteCoverageComplete(result.coverage)).toBe(true);
  });

  it("scores exact Curve stableswap pools through the invariant simulation", () => {
    const stableswapPool = (amplification: number, balances: [number, number]) => ({
      poolId: `ethereum:0x00000000000000000000000000000000000000a${amplification}`,
      project: "curve",
      chain: "ethereum",
      tvlUsd: balances[0] + balances[1],
      symbol: "USDC / USDT",
      poolType: "curve-stableswap",
      source: "direct_api" as const,
      extra: {
        ammExecutionModel: {
          source: "curve" as const,
          invariant: "stableswap" as const,
          trackedTokenIndex: 0,
          feeRate: 0.0004,
          amplification,
          tokens: [
            {
              address: "0x0000000000000000000000000000000000000021",
              symbol: "USDC",
              decimals: 6,
              balance: balances[0],
              referencePriceUsd: 1,
              referencePriceSource: "tracked-market" as const,
              trackedAssetId: "usdc-circle",
            },
            {
              address: "0x0000000000000000000000000000000000000022",
              symbol: "USDT",
              decimals: 6,
              balance: balances[1],
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
      retainedPools: [stableswapPool(200, [5_000_000, 5_000_000])],
    });
    expect(result.coverage).toMatchObject({
      retainedPoolCount: 1,
      scoreEligiblePoolCount: 1,
      scoreEligibleCapabilityPoolCount: 1,
      unsupportedPoolCount: 0,
      evidenceCounts: { "reserve-based-amm-simulation": 1 },
    });
    expect(isDexExitRouteCoverageComplete(result.coverage)).toBe(true);
    const observation = result.observations[0]!;
    expect(observation).toMatchObject({
      scoreEligible: true,
      confidence: "high",
      output: { kind: "tracked-stablecoin", trackedAssetIds: ["usdt-tether"] },
    });
    expect(validateExitRouteCapacityCurve(observation.capacityCurve!)).toEqual([]);
    // A high-A balanced stable pool fills a request near half its depth
    // within the 200 bps bound — far above what constant-product math with
    // the same balances would allow.
    const point = observation.capacityCurve!.find((entry) => entry.requestedNotionalUsd === 1_000_000)!;
    expect(point.completionRatio).toBe(1);
    expect(point.executionCostBps).toBeGreaterThan(0);
    expect(point.executionCostBps).toBeLessThanOrEqual(point.maxCostBps);

    // Amplification monotonicity: a flatter curve (higher A) executes at
    // least as much as a lower-A pool with identical balances.
    const capacityAt = (amplification: number) =>
      buildP4DexExitRouteObservations({
        stablecoinId: "usdc-circle",
        observedAt: 1_720_000_000,
        retainedPools: [stableswapPool(amplification, [5_000_000, 5_000_000])],
      }).observations[0]!.capacityCurve!.reduce((total, entry) => total + entry.executableUsd, 0);
    expect(capacityAt(1000)).toBeGreaterThanOrEqual(capacityAt(200));
    expect(capacityAt(200)).toBeGreaterThan(capacityAt(5));

    // A pool drained on the output side executes less than a balanced one.
    const drained = buildP4DexExitRouteObservations({
      stablecoinId: "usdc-circle",
      observedAt: 1_720_000_000,
      retainedPools: [stableswapPool(200, [9_000_000, 1_000_000])],
    }).observations[0]!.capacityCurve!;
    const balanced = buildP4DexExitRouteObservations({
      stablecoinId: "usdc-circle",
      observedAt: 1_720_000_000,
      retainedPools: [stableswapPool(200, [5_000_000, 5_000_000])],
    }).observations[0]!.capacityCurve!;
    const totalOf = (curve: typeof drained) => curve.reduce((total, entry) => total + entry.executableUsd, 0);
    expect(totalOf(drained)).toBeLessThan(totalOf(balanced));
  });

  it("matches a pinned static-fee rate-bearing Curve StableSwap-NG quote", () => {
    const result = buildP4DexExitRouteObservations({
      stablecoinId: "frxusd-frax",
      observedAt: 1_785_178_691,
      retainedPools: [
        {
          poolId: "ethereum:0xf292eb6c5dcb693eaaf392d0562a01c3710e5978",
          project: "curve",
          chain: "ethereum",
          tvlUsd: 11_842_920,
          symbol: "sfrxUSD / frxUSD",
          poolType: "curve-stableswap",
          source: "dl",
          extra: {
            ammExecutionModel: {
              source: "curve",
              invariant: "stableswap",
              trackedTokenIndex: 1,
              amplification: 5_000,
              feeRate: 0.0001,
              tokens: [
                {
                  address: "0xcf62f905562626cfcdd2261162a51fd02fc9c5b6",
                  symbol: "sfrxUSD",
                  decimals: 18,
                  balance: 7_494_946.662615514,
                  referencePriceUsd: 1.0001571973088703,
                  referencePriceSource: "source-token-usd",
                },
                {
                  address: "0xcacd6fd266af91b8aed52accc382b4e165586e29",
                  symbol: "frxUSD",
                  decimals: 18,
                  balance: 4_346_120.891108167,
                  referencePriceUsd: 1.000155068994295,
                  referencePriceSource: "source-token-usd",
                  trackedAssetId: "frxusd-frax",
                },
              ],
            },
          },
        },
      ],
    });

    const route = result.observations[0];
    const point = route?.capacityCurve?.find((entry) => entry.requestedNotionalUsd === 100_000);
    expect(point).toMatchObject({
      requestedNotionalUsd: 100_000,
      executableUsd: 100_000,
      completionRatio: 1,
    });
    // At pinned Ethereum block 25,626,087, this $100K input maps to
    // 99,984.49550483696 frxUSD. get_dy(1, 0, dx) returned
    // 83,063.84319335324 sfrxUSD ($99,996.11950303978), or 0.388049696 bps.
    expect(point?.executionCostBps).toBeCloseTo(0.38805, 5);
  });

  it("retains realized cost for a full 25m Curve 3pool-style USDT exit", () => {
    const result = buildP4DexExitRouteObservations({
      stablecoinId: "usdt-tether",
      observedAt: 1_753_343_891,
      retainedPools: [
        {
          poolId: "ethereum:0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7",
          project: "curve",
          chain: "ethereum",
          tvlUsd: 160_047_206,
          symbol: "DAI / USDC / USDT",
          poolType: "curve-stableswap",
          source: "dl",
          extra: {
            ammExecutionModel: {
              source: "curve",
              invariant: "stableswap",
              trackedTokenIndex: 2,
              // The pools endpoint omits the fee, so production uses its
              // documented 10 bps source-API fallback for this legacy model.
              feeRate: 0.001,
              amplification: 4000 / 9,
              tokens: [
                {
                  address: "0x6b175474e89094c44da98b954eedeac495271d0f",
                  symbol: "DAI",
                  decimals: 18,
                  balance: 28_348_143.889771747,
                  referencePriceUsd: 1,
                  referencePriceSource: "source-token-usd",
                  trackedAssetId: "dai-makerdao",
                },
                {
                  address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
                  symbol: "USDC",
                  decimals: 6,
                  balance: 28_486_107.228271,
                  referencePriceUsd: 1,
                  referencePriceSource: "source-token-usd",
                  trackedAssetId: "usdc-circle",
                },
                {
                  address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
                  symbol: "USDT",
                  decimals: 6,
                  balance: 103_289_773.79734,
                  referencePriceUsd: 0.9992518040104241,
                  referencePriceSource: "source-token-usd",
                  trackedAssetId: "usdt-tether",
                },
              ],
            },
          },
        },
      ],
    });

    const usdcRoute = result.observations.find(
      (observation) => observation.output.trackedAssetIds?.[0] === "usdc-circle",
    );
    const point = usdcRoute?.capacityCurve?.find((entry) => entry.requestedNotionalUsd === 25_000_000);
    expect(point).toMatchObject({
      executableUsd: 25_000_000,
      completionRatio: 1,
      maxCostBps: 200,
    });
    // Curve computes the invariant against full input, then deducts its fee
    // from the output. Applying the fee to input would understate this cost.
    expect(point?.executionCostBps).toBeCloseTo(54.737382, 5);
    expect(point?.executionCostBps).toBeLessThan(200);
  });

  it("scores Balancer stableswap models and rejects other stableswap sources", () => {
    const balancerStableswapPool = (source: "balancer" | "raydium") => ({
      poolId: "ethereum:0x00000000000000000000000000000000000000b1",
      project: "balancer",
      chain: "ethereum",
      tvlUsd: 10_000_000,
      symbol: "USDC / wUSDX",
      poolType: "balancer-stable",
      source: "direct_api" as const,
      extra: {
        ammExecutionModel: {
          source,
          invariant: "stableswap" as const,
          trackedTokenIndex: 0,
          feeRate: 0.0001,
          amplification: 125,
          tokens: [
            {
              address: "0x0000000000000000000000000000000000000031",
              symbol: "USDC",
              decimals: 6,
              balance: 5_000_000,
              referencePriceUsd: 1,
              referencePriceSource: "source-token-usd" as const,
              trackedAssetId: "usdc-circle",
            },
            {
              address: "0x0000000000000000000000000000000000000032",
              symbol: "wUSDX",
              decimals: 18,
              balance: 5_100_000,
              referencePriceUsd: 0.999,
              referencePriceSource: "source-token-usd" as const,
            },
          ],
        },
      },
    });

    const result = buildP4DexExitRouteObservations({
      stablecoinId: "usdc-circle",
      observedAt: 1_720_000_000,
      retainedPools: [balancerStableswapPool("balancer")],
    });
    expect(result.coverage).toMatchObject({
      retainedPoolCount: 1,
      scoreEligiblePoolCount: 1,
      unsupportedPoolCount: 0,
      evidenceCounts: { "reserve-based-amm-simulation": 1 },
    });
    expect(isDexExitRouteCoverageComplete(result.coverage)).toBe(true);
    expect(result.observations[0]).toMatchObject({
      scoreEligible: true,
      confidence: "high",
      output: { kind: "collateral" },
    });
    expect(
      result.observations[0]!.capacityCurve!.every(
        (point) =>
          point.executableUsd === 0 ||
          (point.completionRatio === 1
            ? point.executionCostBps != null && point.executionCostBps <= point.maxCostBps
            : point.executionCostBps == null),
      ),
    ).toBe(true);

    const rejected = buildP4DexExitRouteObservations({
      stablecoinId: "usdc-circle",
      observedAt: 1_720_000_000,
      retainedPools: [balancerStableswapPool("raydium")],
    });
    expect(rejected.observations).toEqual([]);
    expect(rejected.coverage.scoreEligibleCapabilityPoolCount).toBe(1);
    expect(rejected.coverage.unsupportedPoolCount).toBe(1);
    expect(rejected.coverage.unsupportedReasons).toMatchObject({
      "invalidExecutionModel:invalid-stableswap-model-source": 1,
    });
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
      scoreEligibleCapabilityPoolCount: 0,
      unsupportedPoolCount: 1,
      unsupportedReasons: {
        "nonExecutableEvidence:curve-stableswap-shaped": 1,
      },
    });
  });

  it("keeps reviewed invariant, rate-bearing, and pause gates in the completeness denominator", () => {
    const result = buildP4DexExitRouteObservations({
      stablecoinId: "usdc-circle",
      observedAt: 1_720_000_000,
      retainedPools: [
        {
          poolId: "ethereum:0xcrypto",
          project: "curve",
          chain: "ethereum",
          tvlUsd: 5_000_000,
          symbol: "USDC / WETH",
          poolType: "curve-cryptoswap",
          source: "dl",
          extra: {
            executionCapabilityGate: { family: "curve-cryptoswap", reason: "unsupported-invariant" },
          },
        },
        {
          poolId: "ethereum:0xrate",
          project: "curve",
          chain: "ethereum",
          tvlUsd: 8_000_000,
          symbol: "USDC / sUSDe",
          poolType: "curve-stableswap",
          source: "dl",
          extra: {
            executionCapabilityGate: { family: "curve-stableswap", reason: "rate-bearing-inputs" },
          },
        },
        {
          poolId: "ethereum:0xpaused",
          project: "balancer",
          chain: "ethereum",
          tvlUsd: 3_000_000,
          symbol: "USDC / USDT",
          poolType: "balancer-stable",
          source: "direct_api",
          extra: {
            executionCapabilityGate: { family: "balancer-amm", reason: "paused-or-swap-disabled" },
          },
        },
        {
          poolId: "ethereum:0xgeneric-dl",
          project: "uniswap-v3",
          chain: "ethereum",
          tvlUsd: 7_000_000,
          symbol: "USDC / USDT",
          poolType: "uniswap-v3-5bp",
          source: "dl",
        },
        {
          poolId: "ethereum:0xgeneric-direct",
          project: "aerodrome",
          chain: "base",
          tvlUsd: 4_000_000,
          symbol: "USDC / USDbC",
          poolType: "aerodrome-stable",
          source: "direct_api",
        },
      ],
    });

    expect(result.observations).toEqual([]);
    expect(result.coverage).toMatchObject({
      retainedPoolCount: 5,
      scoreEligibleCapabilityPoolCount: 3,
      scoreEligiblePoolCount: 0,
      unsupportedPoolCount: 5,
      unsupportedReasons: {
        "executionCapabilityGate:curve-cryptoswap:unsupported-invariant": 1,
        "executionCapabilityGate:curve-stableswap:rate-bearing-inputs": 1,
        "executionCapabilityGate:balancer-amm:paused-or-swap-disabled": 1,
        "nonExecutableEvidence:defillama-pool-shaped": 1,
        "nonExecutableEvidence:direct-api-amm-shaped": 1,
      },
    });
    expect(isDexExitRouteCoverageComplete(result.coverage)).toBe(false);
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
    const capacityCurve = result.observations[0]!.capacityCurve!;
    expect(validateExitRouteCapacityCurve(capacityCurve)).toEqual([]);
    expect(capacityCurve.every((point) => point.completionRatio < 1 && point.executionCostBps == null)).toBe(true);
  });

  it("simulates a factory-verified EVM V2 constant-product exit", () => {
    const result = buildP4DexExitRouteObservations({
      stablecoinId: "u-united-stables",
      observedAt: 1_720_000_000,
      retainedPools: [
        {
          poolId: "bsc:0x108752b2a22c731ede3edac2205c63ae553e221a",
          project: "pancakeswap",
          chain: "bsc",
          tvlUsd: 2_000_000,
          symbol: "U / WBNB",
          poolType: "ds-amm",
          source: "dexscreener",
          extra: {
            ammExecutionModel: {
              source: "pancakeswap-v2",
              invariant: "constant-product",
              trackedTokenIndex: 0,
              feeRate: 0.0025,
              tokens: [
                {
                  address: "0xce24439f2d9c6a2289f741120fe202248b666666",
                  symbol: "U",
                  decimals: 18,
                  balance: 1_000_000,
                  referencePriceUsd: 1,
                  referencePriceSource: "tracked-market",
                  trackedAssetId: "u-united-stables",
                },
                {
                  address: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
                  symbol: "WBNB",
                  decimals: 18,
                  balance: 2_000,
                  referencePriceUsd: 500,
                  referencePriceSource: "pool-implied",
                },
              ],
            },
          },
        },
      ],
    });

    expect(result.coverage).toMatchObject({
      scoreEligibleCapabilityPoolCount: 1,
      scoreEligiblePoolCount: 1,
      unsupportedPoolCount: 0,
      evidenceCounts: { "reserve-based-amm-simulation": 1 },
    });
    expect(result.observations[0]).toMatchObject({
      scope: { contractOrPoolId: "bsc:0x108752b2a22c731ede3edac2205c63ae553e221a" },
      output: { kind: "collateral" },
      scoreEligible: true,
    });
  });

  it("omits realized cost when an exact AMM route has zero executable capacity", () => {
    const result = buildP4DexExitRouteObservations({
      stablecoinId: "usdc-circle",
      observedAt: 1_720_000_000,
      retainedPools: [
        {
          poolId: "ethereum:0x0000000000000000000000000000000000000001",
          project: "uniswap-v2",
          chain: "ethereum",
          tvlUsd: 1_500_000,
          symbol: "USDC / TOKEN",
          poolType: "uniswap-v2",
          source: "dl",
          extra: {
            ammExecutionModel: {
              source: "uniswap-v2",
              invariant: "constant-product",
              trackedTokenIndex: 0,
              feeRate: 0.003,
              tokens: [
                {
                  address: "0x0000000000000000000000000000000000000011",
                  symbol: "USDC",
                  decimals: 6,
                  balance: 1_000_000,
                  referencePriceUsd: 1,
                  referencePriceSource: "tracked-market",
                  trackedAssetId: "usdc-circle",
                },
                {
                  address: "0x0000000000000000000000000000000000000012",
                  symbol: "TOKEN",
                  decimals: 18,
                  balance: 1_000_000,
                  referencePriceUsd: 0.5,
                  referencePriceSource: "tracked-market",
                },
              ],
            },
          },
        },
      ],
    });

    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]!.capacityCurve!.every((point) => point.executableUsd === 0)).toBe(true);
    expect(
      result.observations[0]!.capacityCurve!.every(
        (point) => !Object.prototype.hasOwnProperty.call(point, "executionCostBps"),
      ),
    ).toBe(true);
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
    expect(result.observations[0]!.capacityCurve![0]!.executionCostBps).toBeUndefined();
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
    const evmV2 = DEX_ROUTE_SOURCE_CAPABILITIES.find((capability) => capability.id === "evm-v2-constant-product-exact");
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
    expect(evmV2).toMatchObject({
      exactBalancesOrReserves: "exact",
      poolInvariantParameters: "exact",
      outputEvidenceKind: "reserve-based-amm-simulation",
      scoreEligible: true,
    });
  });
});
