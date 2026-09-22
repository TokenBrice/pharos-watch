import type { DexAmmExecutionModel } from "@shared/types/market";
import {
  DEX_MEASURED_ADAPTER_PROFILE_IDS,
  DEX_MEASURED_CAPACITY_NOTIONALS_USD,
  DEX_MEASURED_MAX_COST_BPS,
  type DexMeasuredExecutionPublicProfile,
} from "@shared/types/measured-execution";
import type { buildP4DexExitRouteObservations } from "@shared/lib/p4-exit-route-capacity";
import { makeMeasuredProfile } from "@shared/test-utils/measured-execution.test-support";

type RetainedPool = Parameters<typeof buildP4DexExitRouteObservations>[0]["retainedPools"][number];

export function retainedPool(
  poolId: string,
  project: string,
  chain: string,
  tvlUsd: number,
  symbol: string,
  poolType: string,
  source: RetainedPool["source"],
  extra?: RetainedPool["extra"],
): RetainedPool {
  const pool = { poolId, project, chain, tvlUsd, symbol, poolType, source };
  return extra === undefined ? pool : { ...pool, extra };
}

export function retainedMeasuredPool(
  profile: DexMeasuredExecutionPublicProfile,
  overrides: Partial<RetainedPool> = {},
): RetainedPool {
  return {
    poolId: "defillama-yields-uuid",
    project: profile.protocol,
    chain: profile.chain,
    tvlUsd: profile.retainedTvlUsdAtQuote,
    symbol: `${profile.tokenIn.symbol}-${profile.tokenOut.symbol}`,
    poolType: profile.protocol,
    source: "dl",
    extra: { measuredExecution: profile, measuredExecutionPhysicalPoolId: profile.poolId },
    ...overrides,
  };
}

export function twoTokenReserveModel(
  input: Partial<DexAmmExecutionModel["tokens"][number]> = {},
  output: Partial<DexAmmExecutionModel["tokens"][number]> = {},
  overrides: Partial<DexAmmExecutionModel> = {},
): DexAmmExecutionModel {
  return {
    source: "raydium",
    invariant: "constant-product",
    trackedTokenIndex: 0,
    feeRate: 0.0025,
    tokens: [
      { address: "UsdcMint", symbol: "USDC", decimals: 6, balance: 2_000_000,
        referencePriceUsd: 1, referencePriceSource: "tracked-market", trackedAssetId: "usdc-circle", ...input },
      { address: "UsdtMint", symbol: "USDT", decimals: 6, balance: 2_000_000,
        referencePriceUsd: 1, referencePriceSource: "tracked-market", trackedAssetId: "usdt-tether", ...output },
    ],
    ...overrides,
  };
}
  export function aerodromeMeasuredProfile(quotedAt: number): DexMeasuredExecutionPublicProfile {
    const profile = makeMeasuredProfile(quotedAt);
    if (!profile.poolProvenance) throw new Error("Measured fixture must retain pool provenance");
    return makeMeasuredProfile(quotedAt, {
      adapterProfileId: "aerodrome-slipstream-quoter-v2",
      protocol: "aerodrome-slipstream",
      chain: "base",
      poolId: `base:${profile.poolProvenance.resolvedPoolAddress}`,
    });
  }

  export function uniswapV4MeasuredProfile(quotedAt: number): DexMeasuredExecutionPublicProfile {
    const { poolProvenance: _poolProvenance, ...profile } = makeMeasuredProfile(quotedAt);
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

  export function curveMeasuredProfile(quotedAt: number): DexMeasuredExecutionPublicProfile {
    const poolAddress = "0x313698667d7fdd6789a9bc70821309ff891e729a" as const;
    const crvUsd = "0xf939e0a03fb07f59a73314e73794be0e57ac1b4e" as const;
    const wbtc = "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599" as const;
    return makeMeasuredProfile(quotedAt, {
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
    });
  }

  export function curveStableSwapMeasuredProfiles(
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
      const capacityCurve = DEX_MEASURED_CAPACITY_NOTIONALS_USD.map((requestedNotionalUsd) => ({
        requestedNotionalUsd,
        maxCostBps: DEX_MEASURED_MAX_COST_BPS,
        executableUsd: requestedNotionalUsd,
        completionRatio: 1,
        executionCostBps: outputIndex === 0 ? 55 : 46,
      }));
      return makeMeasuredProfile(quotedAt, {
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
      });
    });
  }

  export function curveThreePoolAmmModel(balances = [28_348_143, 28_486_107, 103_289_773]) {
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
          balance: balances[0]!,
          referencePriceUsd: 1,
          referencePriceSource: "source-token-usd" as const,
          trackedAssetId: "dai-makerdao",
        },
        {
          address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          symbol: "USDC",
          decimals: 6,
          balance: balances[1]!,
          referencePriceUsd: 1,
          referencePriceSource: "source-token-usd" as const,
          trackedAssetId: "usdc-circle",
        },
        {
          address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
          symbol: "USDT",
          decimals: 6,
          balance: balances[2]!,
          referencePriceUsd: 0.9992518040104241,
          referencePriceSource: "source-token-usd" as const,
          trackedAssetId: "usdt-tether",
        },
      ],
    };
  }

  export function curveStableSwapNgMeasuredProfile(
    quotedAt: number,
    completeCycles: number,
    successfulCycles = completeCycles,
  ): DexMeasuredExecutionPublicProfile {
    const poolAddress = "0xc061caa073f3d95f80f8e5428d32d2d76f5e1622" as const;
    const usdg = "0xe343167631d89b6ffc58b88d6b7fb0228795491d" as const;
    const usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as const;
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
    return makeMeasuredProfile(quotedAt, {
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
    });
  }

  export function curveDusdStableSwapNgMeasuredProfile(
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

  export function curveStableSwapNgAmmModel() {
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
