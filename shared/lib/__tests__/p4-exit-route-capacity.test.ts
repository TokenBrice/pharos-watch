import { describe, expect, it } from "vitest";
import { ExitRouteObservationCoverageSchema } from "@shared/types/market";
import {
  DEX_MEASURED_CAPACITY_NOTIONALS_USD,
  DEX_MEASURED_EXECUTION_SCHEMA_VERSION,
  DEX_MEASURED_MAX_COST_BPS,
  type DexMeasuredExecutionPublicProfile,
} from "@shared/types/measured-execution";
import {
  SOLANA_MEASURED_EXECUTION_SCHEMA_VERSION,
  type SolanaMeasuredExecutionPublicProfile,
} from "@shared/types/solana-measured-execution";
import {
  TRON_MEASURED_EXECUTION_SCHEMA_VERSION,
  type TronMeasuredExecutionPublicProfile,
} from "@shared/types/tron-measured-execution";
import {
  DEX_ROUTE_SOURCE_CAPABILITIES,
  P4_AMM_MODELED_TVL_MAX_RATIO,
  P4_AMM_MODELED_TVL_MIN_RATIO,
  buildP4DexExitRouteObservations,
  isDexExitRouteCoverageComplete,
  isDexExitRouteCoverageWithinRouteBudget,
  validateExitRouteCapacityCurve,
} from "../p4-exit-route-capacity";

describe("P4 DEX exit route observations", () => {
  function measuredProfile(quotedAt: number): DexMeasuredExecutionPublicProfile {
    const physicalPool = "0x3333333333333333333333333333333333333333" as const;
    return {
      schemaVersion: DEX_MEASURED_EXECUTION_SCHEMA_VERSION,
      kind: "measured-executable-depth",
      targetId: "target-1",
      targetGenerationId: "target-generation",
      quoteGenerationId: "quote-generation",
      adapterProfileId: "uniswap-v3-quoter-v2",
      protocol: "uniswap-v3",
      chain: "ethereum",
      poolId: `ethereum:${physicalPool}`,
      poolTokenAddresses: ["0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222"],
      tokenIn: {
        address: "0x1111111111111111111111111111111111111111",
        symbol: "USDC",
        decimals: 6,
        referencePriceUsd: 1,
        trackedAssetId: "usdc-circle",
      },
      tokenOut: {
        address: "0x2222222222222222222222222222222222222222",
        symbol: "USDT",
        decimals: 6,
        referencePriceUsd: 1,
        trackedAssetId: "usdt-tether",
      },
      feePips: 100,
      retainedTvlUsdAtQuote: 2_000_000,
      retainedPoolPriceUsdAtQuote: 1,
      quotedAt,
      blockNumber: 25_536_894,
      executionEndpoint: {
        address: "0x4444444444444444444444444444444444444444",
        codeHash: `0x${"ab".repeat(32)}`,
      },
      poolProvenance: {
        factoryAddress: "0x5555555555555555555555555555555555555555",
        factoryCodeHash: `0x${"cd".repeat(32)}`,
        resolvedPoolAddress: physicalPool,
      },
      maxCostBps: DEX_MEASURED_MAX_COST_BPS,
      marginalOutputRatio: 0.999,
      capacityCurve: DEX_MEASURED_CAPACITY_NOTIONALS_USD.map((requestedNotionalUsd) => {
        const executableUsd = Math.min(requestedNotionalUsd, 1_000_000);
        return {
          requestedNotionalUsd,
          maxCostBps: DEX_MEASURED_MAX_COST_BPS,
          executableUsd,
          completionRatio: executableUsd / requestedNotionalUsd,
        };
      }),
    };
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

  function nativeCapacityCurve() {
    return DEX_MEASURED_CAPACITY_NOTIONALS_USD.map((requestedNotionalUsd) => {
      const executableUsd = Math.min(requestedNotionalUsd, 1_000_000);
      return {
        requestedNotionalUsd,
        maxCostBps: DEX_MEASURED_MAX_COST_BPS,
        executableUsd,
        completionRatio: executableUsd / requestedNotionalUsd,
      };
    });
  }

  function solanaMeasuredProfile(quotedAt: number): SolanaMeasuredExecutionPublicProfile {
    return {
      schemaVersion: SOLANA_MEASURED_EXECUTION_SCHEMA_VERSION,
      kind: "measured-executable-depth",
      targetId: "solana-target-1",
      targetGenerationId: "solana-target-generation",
      quoteGenerationId: "solana-quote-generation",
      adapterProfileId: "orca-whirlpool-jupiter-v1",
      protocol: "orca",
      chain: "solana",
      poolId: "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE",
      poolType: "orca-whirlpool",
      tokenIn: {
        address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        symbol: "USDC",
        decimals: 6,
        referencePriceUsd: 1,
        referencePriceSource: "tracked",
        trackedAssetId: "usdc-circle",
      },
      tokenOut: {
        address: "Es9vMFrzaCERmJfrF4H2FYDgK5KJY8PYdG7yM7pTz1C",
        symbol: "USDT",
        decimals: 6,
        referencePriceUsd: 1,
        referencePriceSource: "tracked",
        trackedAssetId: "usdt-tether",
      },
      retainedTvlUsdAtQuote: 2_000_000,
      retainedPoolPriceUsdAtQuote: 1,
      quotedAt,
      slotWindow: { before: 1_000, after: 1_010 },
      maxCostBps: DEX_MEASURED_MAX_COST_BPS,
      marginalOutputRatio: 0.999,
      capacityCurve: nativeCapacityCurve(),
    };
  }

  function tronMeasuredProfile(quotedAt: number): TronMeasuredExecutionPublicProfile {
    return {
      schemaVersion: TRON_MEASURED_EXECUTION_SCHEMA_VERSION,
      kind: "measured-executable-depth",
      targetId: "tron-target-1",
      targetGenerationId: "tron-target-generation",
      quoteGenerationId: "tron-quote-generation",
      adapterProfileId: "sunswap-v2-router-v1",
      protocol: "sunswap",
      chain: "tron",
      poolId: "TFGDbUyP8xez44C76fin3bn3Ss6jugoUwJ",
      poolType: "sunswap-v2",
      tokenIn: {
        address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
        symbol: "USDT",
        decimals: 6,
        referencePriceUsd: 1,
        referencePriceSource: "tracked",
        trackedAssetId: "usdt-tether",
      },
      tokenOut: {
        address: "TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR",
        symbol: "WTRX",
        decimals: 6,
        referencePriceUsd: 0.3,
        referencePriceSource: "source-token-usd",
      },
      retainedTvlUsdAtQuote: 2_000_000,
      retainedPoolPriceUsdAtQuote: 1,
      quotedAt,
      maxCostBps: DEX_MEASURED_MAX_COST_BPS,
      marginalOutputRatio: 0.999,
      capacityCurve: nativeCapacityCurve(),
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
        adapterProfileId: "curve-stableswap-main-registry-get-dy-v1",
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
      adapterProfileId: "curve-stableswap-ng-factory-get-dy-v2",
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

  it("emits active Solana and Tron measured profiles into P4 capacity and completeness", () => {
    const observedAt = 10_000;
    const cases = [
      {
        stablecoinId: "usdc-circle",
        project: "orca",
        chain: "Solana",
        poolType: "orca-whirlpool",
        profile: solanaMeasuredProfile(observedAt - 60),
      },
      {
        stablecoinId: "usdt-tether",
        project: "sunswap-v2",
        chain: "Tron",
        poolType: "sunswap-v2",
        profile: tronMeasuredProfile(observedAt - 60),
      },
    ];

    for (const testCase of cases) {
      const result = buildP4DexExitRouteObservations({
        stablecoinId: testCase.stablecoinId,
        observedAt,
        retainedPools: [{
          poolId: `${testCase.profile.chain}:${testCase.profile.poolId}`,
          project: testCase.project,
          chain: testCase.chain,
          tvlUsd: 2_000_000,
          symbol: `${testCase.profile.tokenIn.symbol} / ${testCase.profile.tokenOut.symbol}`,
          poolType: testCase.poolType,
          source: testCase.profile.chain === "solana" ? "direct_api" : "dl",
          extra: {
            nativeMeasuredExecution: testCase.profile,
            nativeMeasuredExecutionPhysicalPoolId: testCase.profile.poolId,
          },
        }],
      });

      expect(result.observations).toEqual([
        expect.objectContaining({
          adapterProfileId: testCase.profile.adapterProfileId,
          evidenceKind: "measured-executable-depth",
          executableUsd: 1_000_000,
          scoreEligible: true,
          confidence: "medium",
        }),
      ]);
      expect(result.coverage).toMatchObject({
        status: "populated",
        scoreEligiblePoolCount: 1,
        scoreEligibleCapabilityPoolCount: 1,
        unsupportedPoolCount: 0,
      });
      expect(isDexExitRouteCoverageComplete(result.coverage)).toBe(true);
    }
  });

  it("keeps invalid or activation-gated native profiles in the incomplete denominator", () => {
    const observedAt = 10_000;
    const profile = solanaMeasuredProfile(observedAt - 60);
    const invalid = buildP4DexExitRouteObservations({
      stablecoinId: "usdc-circle",
      observedAt,
      retainedPools: [{
        poolId: `solana:${profile.poolId}`,
        project: "orca",
        chain: "Solana",
        tvlUsd: 2_000_000,
        symbol: "USDC / USDT",
        poolType: "orca-whirlpool",
        source: "direct_api",
        extra: {
          nativeMeasuredExecution: profile,
          nativeMeasuredExecutionPhysicalPoolId: profile.poolId.toLowerCase(),
        },
      }],
    });
    expect(invalid.observations).toEqual([]);
    expect(invalid.coverage).toMatchObject({
      scoreEligiblePoolCount: 0,
      scoreEligibleCapabilityPoolCount: 1,
      unsupportedReasons: {
        "invalidMeasuredExecution:retained-physical-pool-mismatch": 1,
      },
    });

    const gatedProfile = tronMeasuredProfile(observedAt - 60);
    const gated = buildP4DexExitRouteObservations({
      stablecoinId: "usdt-tether",
      observedAt,
      retainedPools: [{
        poolId: `tron:${gatedProfile.poolId}`,
        project: "sunswap-v2",
        chain: "Tron",
        tvlUsd: 2_000_000,
        symbol: "USDT / WTRX",
        poolType: "sunswap-v2",
        source: "dl",
        extra: {
          executionCapabilityGate: { family: "measured-execution", reason: "activation-pending" },
          nativeMeasuredExecution: gatedProfile,
          nativeMeasuredExecutionPhysicalPoolId: gatedProfile.poolId,
        },
      }],
    });
    expect(gated.observations).toEqual([]);
    expect(gated.coverage).toMatchObject({
      scoreEligiblePoolCount: 0,
      scoreEligibleCapabilityPoolCount: 1,
      unsupportedReasons: {
        "executionCapabilityGate:measured-execution:activation-pending": 1,
      },
    });
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
      capabilityMatrixVersion: "p4a.8",
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
      capabilityMatrixVersion: "p4a.8",
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
        observation.adapterProfileId === "curve-stableswap-main-registry-get-dy-v1",
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
    expect(run(3, 7_199).observations).toHaveLength(2);
    const expired = run(3, 7_201);
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
      capabilityMatrixVersion: "p4a.8",
      retainedPoolCount: 1,
      observationCount: 1,
      scoreEligibleCapabilityPoolCount: 1,
      scoreEligiblePoolCount: 1,
      unsupportedPoolCount: 0,
      evidenceCounts: { "measured-executable-depth": 1 },
    });
    expect(mature.observations[0]).toMatchObject({
      evidenceKind: "measured-executable-depth",
      adapterProfileId: "curve-stableswap-ng-factory-get-dy-v2",
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
        profile: measuredProfile(observedAt - 3_601),
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
      capabilityMatrixVersion: "p4a.8",
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
    // USD1-shaped surface: 283 capability pools, 10 selected and observed,
    // 273 omitted solely by the bounded route-selection budget.
    const overflowOnlyCoverage = {
      status: "populated" as const,
      capabilityMatrixVersion: "p4a.8",
      retainedPoolCount: 283,
      observationCount: 10,
      scoreEligibleObservationCount: 10,
      scoreEligiblePoolCount: 10,
      scoreEligibleCapabilityPoolCount: 283,
      unsupportedPoolCount: 273,
      evidenceCounts: { "measured-executable-depth": 10 },
      unsupportedReasons: { routeSelectionCapabilityOverflow: 273 },
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
        routeSelectionCapabilityOverflow: 2,
        "executionCapabilityGate:measured-execution:quote-failed": 6,
      },
    };
    expect(isDexExitRouteCoverageComplete(gatedCoverage)).toBe(false);
    expect(isDexExitRouteCoverageWithinRouteBudget(gatedCoverage)).toBe(false);

    // Without overflow the budget predicate matches the strict one.
    const strictComplete = {
      ...overflowOnlyCoverage,
      retainedPoolCount: 10,
      scoreEligibleCapabilityPoolCount: 10,
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
              // The pools endpoint omits the fee, so production retains the
              // reviewed conservative 10 bps reserve-simulation bound.
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
    expect(point?.executionCostBps).toBeCloseTo(54.39051, 5);
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
    const nativeMeasured = DEX_ROUTE_SOURCE_CAPABILITIES.find(
      (capability) => capability.id === "native-measured-exact",
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
    expect(evmV2).toMatchObject({
      exactBalancesOrReserves: "exact",
      poolInvariantParameters: "exact",
      outputEvidenceKind: "reserve-based-amm-simulation",
      scoreEligible: true,
    });
    expect(nativeMeasured).toMatchObject({
      tokenIdentity: "exact",
      outputEvidenceKind: "measured-executable-depth",
      scoreEligible: true,
    });
  });
});
