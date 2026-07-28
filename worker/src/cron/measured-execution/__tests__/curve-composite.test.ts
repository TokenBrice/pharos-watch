import {
  decodeFunctionData,
  encodeFunctionData,
  encodeFunctionResult,
  parseAbi,
} from "viem/utils";
import { describe, expect, it, vi } from "vitest";

import {
  DexMeasuredExecutionTargetSchema,
  type DexMeasuredExecutionCurveCompositeProof,
  type DexMeasuredExecutionTarget,
} from "@shared/types/measured-execution";
import {
  CURVE_DOLA_SUSDE_RATE_BEARING_POLICY,
  CURVE_METAPOOL_ADAPTER_PROFILE_ID,
  CURVE_NXUSD_METAPOOL_POLICY,
  CURVE_RATE_BEARING_ADAPTER_PROFILE_ID,
  CURVE_USD1_METAPOOL_POLICY,
  buildCurveCompositeMeasuredExecutionTarget,
  createCurveCompositeQuoteExecutor,
  encodeCurveCompositeQuote,
  evaluateCurveCompositeEligibility,
  validateCurveCompositeProfileProof,
  type CurveCompositePoolPolicy,
  type CurveCompositeRuntimeEvidence,
} from "../curve-composite";
import { buildDexMeasuredExecutionProfile } from "../profiles";

const POOL_ABI = parseAbi([
  "function coins(uint256) view returns (address)",
  "function get_dy(int128 i,int128 j,uint256 dx) view returns (uint256)",
  "function get_dy_underlying(int128 i,int128 j,uint256 dx) view returns (uint256)",
  "function stored_rates() view returns (uint256[])",
]);
const FACTORY_ABI = parseAbi([
  "function pool_list(uint256) view returns (address)",
  "function get_coins(address pool) view returns (address[])",
  "function get_implementation_address(address pool) view returns (address)",
  "function get_pool_asset_types(address pool) view returns (uint8[])",
  "function get_base_pool(address pool) view returns (address)",
  "function get_underlying_coins(address pool) view returns (address[])",
  "function get_underlying_decimals(address pool) view returns (uint256[])",
  "function is_meta(address pool) view returns (bool)",
]);
const LEGACY_FACTORY_ARRAY_ABI = parseAbi([
  "function get_coins(address pool) view returns (address[4])",
  "function get_underlying_coins(address pool) view returns (address[8])",
  "function get_underlying_decimals(address pool) view returns (uint256[8])",
]);
const ERC20_ABI = parseAbi(["function decimals() view returns (uint8)"]);
const ERC4626_ABI = parseAbi([
  "function asset() view returns (address)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
]);
const BLOCK_NUMBER = 25_618_327;
const BLOCK_TIMESTAMP = 1_784_970_583;

function addressMap(): Map<string, string> {
  return new Map([
    ["ethereum:0x865377367054516e17014ccded1e7d814edc9ce4", "dola-inverse-finance"],
    ["ethereum:0x9d39a5de30e57443bff2a8307a4256c8797a3497", "susde-ethena"],
    ["ethereum:0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d", "usd1-world-liberty-financial"],
    ["ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "usdc-circle"],
    ["ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7", "usdt-tether"],
    ["avalanche:0xf14f4ce569cb3679e99d5059909e23b07bd2f387", "nxusd-nereus"],
  ]);
}

function priceMap(): Map<string, number> {
  return new Map([
    ["dola-inverse-finance", 0.996],
    ["susde-ethena", 1.24],
    ["usd1-world-liberty-financial", 0.999],
    ["usdc-circle", 1],
    ["usdt-tether", 0.999],
    ["nxusd-nereus", 0.8094],
  ]);
}

function rateTarget() {
  const policy = CURVE_DOLA_SUSDE_RATE_BEARING_POLICY;
  return buildCurveCompositeMeasuredExecutionTarget({
    curveData: {
      poolAddress: policy.poolAddress,
      registryId: "factory-stable-ng",
      isMetaPool: false,
      poolCoins: policy.poolTokens.map((token) => ({
        address: token.address,
        symbol: token.symbol,
        decimals: token.decimals,
        usdPrice: token.symbol === "sUSDe" ? 1.24 : 0.996,
        isBasePoolLpToken: false,
      })),
    },
    chain: policy.chain,
    stablecoinId: policy.stablecoinId,
    chainAddressToId: addressMap(),
    stablecoinPriceById: priceMap(),
    retainedTvlUsd: 39_000_000,
    capturedAt: BLOCK_TIMESTAMP - 60,
  });
}

function metapoolTarget(basePoolAddress = CURVE_USD1_METAPOOL_POLICY.metapool.basePoolAddress) {
  const policy = CURVE_USD1_METAPOOL_POLICY;
  return buildCurveCompositeMeasuredExecutionTarget({
    curveData: {
      poolAddress: policy.poolAddress,
      registryId: "factory-stable-ng",
      isMetaPool: true,
      basePoolAddress,
      poolCoins: policy.poolTokens.map((token, index) => ({
        address: token.address,
        symbol: token.symbol,
        decimals: token.decimals,
        usdPrice: index === 0 ? 0.999 : 1.018,
        isBasePoolLpToken: index === 1,
      })),
    },
    chain: policy.chain,
    stablecoinId: policy.stablecoinId,
    chainAddressToId: addressMap(),
    stablecoinPriceById: priceMap(),
    retainedTvlUsd: 6_800_000,
    capturedAt: BLOCK_TIMESTAMP - 60,
  });
}

function nxusdTarget(
  underlyingCoins = CURVE_NXUSD_METAPOOL_POLICY.executionTokens.map((token, index) => ({
    address: token.address,
    symbol: token.symbol,
    decimals: token.decimals,
    usdPrice: index === 0 ? 0.8094 : index === 2 ? 0.99986 : 0.999,
  })),
) {
  const policy = CURVE_NXUSD_METAPOOL_POLICY;
  return buildCurveCompositeMeasuredExecutionTarget({
    curveData: {
      poolAddress: policy.poolAddress,
      registryId: "factory",
      isMetaPool: true,
      basePoolAddress: policy.metapool.basePoolAddress,
      poolCoins: policy.poolTokens.map((token, index) => ({
        address: token.address,
        symbol: token.symbol,
        decimals: token.decimals,
        usdPrice: index === 0 ? 0.8094 : 1.135,
        isBasePoolLpToken: index === 1,
      })),
      underlyingCoins,
    },
    chain: policy.chain,
    stablecoinId: policy.stablecoinId,
    chainAddressToId: addressMap(),
    stablecoinPriceById: priceMap(),
    retainedTvlUsd: 328_267,
    capturedAt: BLOCK_TIMESTAMP - 60,
  });
}

function bindingCall(
  role: string,
  target: `0x${string}`,
  callData: `0x${string}`,
  returnData: `0x${string}`,
): DexMeasuredExecutionCurveCompositeProof["calls"][number] {
  return {
    role,
    target,
    callData: callData.toLowerCase() as `0x${string}`,
    returnData: returnData.toLowerCase() as `0x${string}`,
  };
}

function encodeFactoryAddresses(
  policy: CurveCompositePoolPolicy,
  functionName: "get_coins" | "get_underlying_coins",
  addresses: readonly `0x${string}`[],
): `0x${string}` {
  if (policy.factoryArrayEncoding === "dynamic") {
    return encodeFunctionResult({
      abi: FACTORY_ABI,
      functionName,
      result: addresses,
    } as never);
  }
  const width = functionName === "get_coins" ? 4 : 8;
  return encodeFunctionResult({
    abi: LEGACY_FACTORY_ARRAY_ABI,
    functionName,
    result: [
      ...addresses,
      ...Array.from(
        { length: width - addresses.length },
        () => "0x0000000000000000000000000000000000000000" as const,
      ),
    ],
  } as never);
}

function encodeFactoryDecimals(
  policy: CurveCompositePoolPolicy,
  decimals: readonly bigint[],
): `0x${string}` {
  if (policy.factoryArrayEncoding === "dynamic") {
    return encodeFunctionResult({
      abi: FACTORY_ABI,
      functionName: "get_underlying_decimals",
      result: decimals,
    });
  }
  return encodeFunctionResult({
    abi: LEGACY_FACTORY_ARRAY_ABI,
    functionName: "get_underlying_decimals",
    result: [...decimals, ...Array.from({ length: 8 - decimals.length }, () => 0n)],
  } as never);
}

function commonBindingCalls(
  policy: CurveCompositePoolPolicy,
): DexMeasuredExecutionCurveCompositeProof["calls"] {
  return [
    bindingCall(
      "factory-pool-list",
      policy.factoryAddress,
      encodeFunctionData({
        abi: FACTORY_ABI,
        functionName: "pool_list",
        args: [BigInt(policy.factoryPoolIndex)],
      }),
      encodeFunctionResult({
        abi: FACTORY_ABI,
        functionName: "pool_list",
        result: policy.poolAddress,
      }),
    ),
    bindingCall(
      "factory-coins",
      policy.factoryAddress,
      encodeFunctionData({
        abi: FACTORY_ABI,
        functionName: "get_coins",
        args: [policy.poolAddress],
      }),
      encodeFactoryAddresses(
        policy,
        "get_coins",
        policy.poolTokens.map((token) => token.address),
      ),
    ),
    bindingCall(
      "factory-implementation",
      policy.factoryAddress,
      encodeFunctionData({
        abi: FACTORY_ABI,
        functionName: "get_implementation_address",
        args: [policy.poolAddress],
      }),
      encodeFunctionResult({
        abi: FACTORY_ABI,
        functionName: "get_implementation_address",
        result: policy.implementationAddress,
      }),
    ),
    ...policy.poolTokens.map((token, index) =>
      bindingCall(
        `pool-coin-${index}`,
        policy.poolAddress,
        encodeFunctionData({
          abi: POOL_ABI,
          functionName: "coins",
          args: [BigInt(index)],
        }),
        encodeFunctionResult({
          abi: POOL_ABI,
          functionName: "coins",
          result: token.address,
        }),
      )
    ),
    ...policy.executionTokens.map((token, index) =>
      bindingCall(
        `token-decimals-${index}`,
        token.address,
        encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "decimals",
        }),
        encodeFunctionResult({
          abi: ERC20_ABI,
          functionName: "decimals",
          result: token.decimals,
        }),
      )
    ),
  ];
}

function rateEvidence(): CurveCompositeRuntimeEvidence {
  const policy = CURVE_DOLA_SUSDE_RATE_BEARING_POLICY;
  const observedRate = 1_240_000_000_000_000_000n;
  return {
    blockTimestamp: BLOCK_TIMESTAMP,
    proof: {
      blockNumber: BLOCK_NUMBER,
      blockHash: `0x${"11".repeat(32)}`,
      blockCommitment: "finalized",
      factoryAddress: policy.factoryAddress,
      factoryCodeHash: policy.expectedFactoryCodeHash,
      poolIndex: policy.factoryPoolIndex,
      registeredPoolAddress: policy.poolAddress,
      poolCodeHash: policy.expectedPoolCodeHash,
      implementationAddress: policy.implementationAddress,
      implementationCodeHash: policy.expectedImplementationCodeHash,
      quoteFunction: policy.quoteFunction,
      poolTokenAddresses: policy.poolTokens.map((token) => token.address),
      executionTokenAddresses: policy.executionTokens.map((token) => token.address),
      calls: [
        ...commonBindingCalls(policy),
        bindingCall(
          "factory-asset-types",
          policy.factoryAddress,
          encodeFunctionData({
            abi: FACTORY_ABI,
            functionName: "get_pool_asset_types",
            args: [policy.poolAddress],
          }),
          encodeFunctionResult({
            abi: FACTORY_ABI,
            functionName: "get_pool_asset_types",
            result: [...policy.expectedAssetTypes],
          }),
        ),
        bindingCall(
          "rate-provider-asset",
          policy.rateProvider.providerAddress,
          encodeFunctionData({
            abi: ERC4626_ABI,
            functionName: "asset",
          }),
          encodeFunctionResult({
            abi: ERC4626_ABI,
            functionName: "asset",
            result: policy.rateProvider.underlyingAddress,
          }),
        ),
        bindingCall(
          "rate-provider-convert",
          policy.rateProvider.providerAddress,
          encodeFunctionData({
            abi: ERC4626_ABI,
            functionName: "convertToAssets",
            args: [10n ** BigInt(policy.poolTokens[policy.rateProvider.tokenIndex].decimals)],
          }),
          encodeFunctionResult({
            abi: ERC4626_ABI,
            functionName: "convertToAssets",
            result: observedRate,
          }),
        ),
        bindingCall(
          "pool-stored-rates",
          policy.poolAddress,
          encodeFunctionData({
            abi: POOL_ABI,
            functionName: "stored_rates",
          }),
          encodeFunctionResult({
            abi: POOL_ABI,
            functionName: "stored_rates",
            result: [1_000_000_000_000_000_000n, observedRate],
          }),
        ),
      ],
      rateProvider: {
        kind: "erc4626",
        tokenAddress: policy.poolTokens[policy.rateProvider.tokenIndex].address,
        providerAddress: policy.rateProvider.providerAddress,
        providerCodeHash: policy.rateProvider.expectedProviderCodeHash,
        underlyingAddress: policy.rateProvider.underlyingAddress,
        observedRate: observedRate.toString(),
      },
    },
  };
}

function metapoolEvidence(
  policy: typeof CURVE_USD1_METAPOOL_POLICY | typeof CURVE_NXUSD_METAPOOL_POLICY =
    CURVE_USD1_METAPOOL_POLICY,
): CurveCompositeRuntimeEvidence {
  return {
    blockTimestamp: BLOCK_TIMESTAMP,
    proof: {
      blockNumber: BLOCK_NUMBER,
      blockHash: `0x${"22".repeat(32)}`,
      blockCommitment: "finalized",
      factoryAddress: policy.factoryAddress,
      factoryCodeHash: policy.expectedFactoryCodeHash,
      poolIndex: policy.factoryPoolIndex,
      registeredPoolAddress: policy.poolAddress,
      poolCodeHash: policy.expectedPoolCodeHash,
      implementationAddress: policy.implementationAddress,
      implementationCodeHash: policy.expectedImplementationCodeHash,
      quoteFunction: policy.quoteFunction,
      poolTokenAddresses: policy.poolTokens.map((token) => token.address),
      executionTokenAddresses: policy.executionTokens.map((token) => token.address),
      calls: [
        ...commonBindingCalls(policy),
        bindingCall(
          "factory-base-pool",
          policy.factoryAddress,
          encodeFunctionData({
            abi: FACTORY_ABI,
            functionName: "get_base_pool",
            args: [policy.poolAddress],
          }),
          encodeFunctionResult({
            abi: FACTORY_ABI,
            functionName: "get_base_pool",
            result: policy.metapool.basePoolAddress,
          }),
        ),
        bindingCall(
          "factory-underlying-coins",
          policy.factoryAddress,
          encodeFunctionData({
            abi: FACTORY_ABI,
            functionName: "get_underlying_coins",
            args: [policy.poolAddress],
          }),
          encodeFactoryAddresses(
            policy,
            "get_underlying_coins",
            policy.executionTokens.map((token) => token.address),
          ),
        ),
        bindingCall(
          "factory-underlying-decimals",
          policy.factoryAddress,
          encodeFunctionData({
            abi: FACTORY_ABI,
            functionName: "get_underlying_decimals",
            args: [policy.poolAddress],
          }),
          encodeFactoryDecimals(
            policy,
            policy.executionTokens.map((token) => BigInt(token.decimals)),
          ),
        ),
        bindingCall(
          "factory-is-meta",
          policy.factoryAddress,
          encodeFunctionData({
            abi: FACTORY_ABI,
            functionName: "is_meta",
            args: [policy.poolAddress],
          }),
          encodeFunctionResult({
            abi: FACTORY_ABI,
            functionName: "is_meta",
            result: true,
          }),
        ),
      ],
      metapool: {
        basePoolAddress: policy.metapool.basePoolAddress,
        basePoolCodeHash: policy.metapool.expectedBasePoolCodeHash,
        basePoolTokenAddresses: policy.metapool.basePoolTokens.map((token) => token.address),
      },
    },
  };
}

function compositeProfile(
  target: DexMeasuredExecutionTarget,
  policy: CurveCompositePoolPolicy,
  evidence: CurveCompositeRuntimeEvidence,
) {
  const amountInRaw = 1_000n * 10n ** BigInt(target.tokenIn.decimals);
  const amountOutRaw = policy.quoteFunction === "get_dy"
    ? 999n * 10n ** 18n
    : 999_000_000n;
  return buildDexMeasuredExecutionProfile({
    target,
    targetGenerationId: "targets-1",
    quoteGenerationId: "quotes-1",
    quotedAt: BLOCK_TIMESTAMP,
    blockNumber: BLOCK_NUMBER,
    endpointAddress: policy.poolAddress,
    endpointCodeHash: policy.expectedPoolCodeHash,
    curveCompositeProof: evidence.proof,
    points: [{
      amountInRaw: amountInRaw.toString(),
      amountOutRaw: amountOutRaw.toString(),
      callData: encodeCurveCompositeQuote({
        policy,
        inputIndex: policy.inputIndex,
        outputIndex: policy.outputIndex,
        amountInRaw,
      }),
      returnData: encodeFunctionResult({
        abi: POOL_ABI,
        functionName: policy.quoteFunction,
        result: amountOutRaw,
      }).toLowerCase() as `0x${string}`,
      inputUsd: 1_000,
      outputUsd: 999,
      costBps: 10,
      passesCostBound: true,
    }],
  });
}

describe("reviewed Curve rate-bearing and metapool targets", () => {
  it("builds exact shadow targets with independently valued outputs", () => {
    const rate = rateTarget();
    const meta = metapoolTarget();
    const nxusd = nxusdTarget();

    expect(DexMeasuredExecutionTargetSchema.safeParse(rate).success).toBe(true);
    expect(DexMeasuredExecutionTargetSchema.safeParse(meta).success).toBe(true);
    expect(DexMeasuredExecutionTargetSchema.safeParse(nxusd).success).toBe(true);
    expect(rate).toMatchObject({
      stablecoinId: "susde-ethena",
      adapterProfileId: CURVE_RATE_BEARING_ADAPTER_PROFILE_ID,
      poolId: `ethereum:${CURVE_DOLA_SUSDE_RATE_BEARING_POLICY.poolAddress}`,
      tokenIn: { symbol: "sUSDe", referencePriceUsd: 1.24 },
      tokenOut: {
        symbol: "DOLA",
        trackedAssetId: "dola-inverse-finance",
        referencePriceUsd: 0.996,
      },
    });
    expect(meta).toMatchObject({
      stablecoinId: "usd1-world-liberty-financial",
      adapterProfileId: CURVE_METAPOOL_ADAPTER_PROFILE_ID,
      poolTokenAddresses: CURVE_USD1_METAPOOL_POLICY.executionTokens.map((token) => token.address),
      tokenOut: { symbol: "USDC", trackedAssetId: "usdc-circle", referencePriceUsd: 1 },
      retainedTvlUsd: 6_800_000,
    });
    expect(nxusd).toMatchObject({
      stablecoinId: "nxusd-nereus",
      adapterProfileId: CURVE_METAPOOL_ADAPTER_PROFILE_ID,
      chain: "avalanche",
      poolId: `avalanche:${CURVE_NXUSD_METAPOOL_POLICY.poolAddress}`,
      poolTokenAddresses: CURVE_NXUSD_METAPOOL_POLICY.executionTokens.map(
        (token) => token.address,
      ),
      tokenIn: {
        address: CURVE_NXUSD_METAPOOL_POLICY.executionTokens[0].address,
        symbol: "NXUSD",
        decimals: 18,
        trackedAssetId: "nxusd-nereus",
        referencePriceUsd: 0.8094,
      },
      tokenOut: {
        address: CURVE_NXUSD_METAPOOL_POLICY.executionTokens[2].address,
        symbol: "avUSDC",
        decimals: 6,
        referencePriceUsd: 1,
      },
      retainedTvlUsd: 328_267,
    });
    expect(nxusd?.tokenOut).not.toHaveProperty("trackedAssetId");
    expect(CURVE_NXUSD_METAPOOL_POLICY).toMatchObject({
      mode: "shadow",
      scoreEligible: false,
      inputIndex: 0,
      outputIndex: 2,
      quoteFunction: "get_dy_underlying",
    });
  });

  it("does not value NXUSD output with the Curve API underlying price", () => {
    const target = nxusdTarget(
      CURVE_NXUSD_METAPOOL_POLICY.executionTokens.map((token, index) => ({
        address: token.address,
        symbol: token.symbol,
        decimals: token.decimals,
        usdPrice: index === CURVE_NXUSD_METAPOOL_POLICY.outputIndex ? 1.05 : 1,
      })),
    );

    expect(target).not.toBeNull();
    expect(target?.tokenOut).toMatchObject({
      symbol: "avUSDC",
      referencePriceUsd: 1,
    });
  });

  it("fails target generation closed on base-pool, coin-order, and registry drift", () => {
    expect(metapoolTarget("0x1111111111111111111111111111111111111111")).toBeNull();
    expect(nxusdTarget([])).toBeNull();
    expect(nxusdTarget(
      CURVE_NXUSD_METAPOOL_POLICY.executionTokens.map((token, index) => ({
        address:
          index === CURVE_NXUSD_METAPOOL_POLICY.outputIndex
            ? "0x1111111111111111111111111111111111111111"
            : token.address,
        symbol: token.symbol,
        decimals: token.decimals,
        usdPrice: 1,
      })),
    )).toBeNull();
    const policy = CURVE_DOLA_SUSDE_RATE_BEARING_POLICY;
    expect(buildCurveCompositeMeasuredExecutionTarget({
      curveData: {
        poolAddress: policy.poolAddress,
        registryId: "main",
        isMetaPool: false,
        poolCoins: [...policy.poolTokens].reverse().map((token) => ({
          address: token.address,
          symbol: token.symbol,
          decimals: token.decimals,
          usdPrice: 1,
          isBasePoolLpToken: false,
        })),
      },
      chain: "ethereum",
      stablecoinId: policy.stablecoinId,
      chainAddressToId: addressMap(),
      stablecoinPriceById: priceMap(),
      retainedTvlUsd: 39_000_000,
      capturedAt: BLOCK_TIMESTAMP,
    })).toBeNull();
  });

  it("pins the direct and underlying quote ABIs to reviewed indices", () => {
    const direct = decodeFunctionData({
      abi: POOL_ABI,
      data: encodeCurveCompositeQuote({
        policy: CURVE_DOLA_SUSDE_RATE_BEARING_POLICY,
        inputIndex: 1,
        outputIndex: 0,
        amountInRaw: 1_000_000_000_000_000_000n,
      }),
    });
    const underlying = decodeFunctionData({
      abi: POOL_ABI,
      data: encodeCurveCompositeQuote({
        policy: CURVE_USD1_METAPOOL_POLICY,
        inputIndex: 0,
        outputIndex: 1,
        amountInRaw: 1_000_000_000_000_000_000n,
      }),
    });
    const nxusdUnderlying = decodeFunctionData({
      abi: POOL_ABI,
      data: encodeCurveCompositeQuote({
        policy: CURVE_NXUSD_METAPOOL_POLICY,
        inputIndex: 0,
        outputIndex: 2,
        amountInRaw: 1_000_000_000_000_000_000n,
      }),
    });
    expect(direct.functionName).toBe("get_dy");
    expect(direct.args).toEqual([1n, 0n, 1_000_000_000_000_000_000n]);
    expect(underlying.functionName).toBe("get_dy_underlying");
    expect(underlying.args).toEqual([0n, 1n, 1_000_000_000_000_000_000n]);
    expect(nxusdUnderlying.functionName).toBe("get_dy_underlying");
    expect(nxusdUnderlying.args).toEqual([0n, 2n, 1_000_000_000_000_000_000n]);
  });

  it("requires exact rate-provider and metapool/base-pool proof summaries", () => {
    expect(evaluateCurveCompositeEligibility({
      chain: "ethereum",
      endpointAddress: CURVE_DOLA_SUSDE_RATE_BEARING_POLICY.poolAddress,
      blockNumber: BLOCK_NUMBER,
      nowSec: BLOCK_TIMESTAMP + 60,
      evidence: rateEvidence(),
    })).toEqual({ ok: true });
    expect(evaluateCurveCompositeEligibility({
      chain: "avalanche",
      endpointAddress: CURVE_NXUSD_METAPOOL_POLICY.poolAddress,
      blockNumber: BLOCK_NUMBER,
      nowSec: BLOCK_TIMESTAMP + 60,
      evidence: metapoolEvidence(CURVE_NXUSD_METAPOOL_POLICY),
    })).toEqual({ ok: true });
    expect(evaluateCurveCompositeEligibility({
      chain: "ethereum",
      endpointAddress: CURVE_USD1_METAPOOL_POLICY.poolAddress,
      blockNumber: BLOCK_NUMBER,
      nowSec: BLOCK_TIMESTAMP + 60,
      evidence: {
        ...metapoolEvidence(),
        proof: {
          ...metapoolEvidence().proof,
          metapool: {
            ...metapoolEvidence().proof.metapool!,
            basePoolAddress: "0x1111111111111111111111111111111111111111",
          },
        },
      },
    })).toEqual({ ok: false, reason: "base-pool-mismatch" });
  });

  it("pins the reviewed NXUSD pool, legacy factory, implementation, and base-pool code", () => {
    expect(CURVE_NXUSD_METAPOOL_POLICY).toMatchObject({
      chain: "avalanche",
      poolAddress: "0x6bf6fc7eaf84174bb7e1610efd865f0ebd2aa96d",
      expectedPoolCodeHash:
        "0x189567179f11c501b47c595502e59f75c31e36e0a8cf95ba5f73ef6fff5d74a3",
      factoryAddress: "0xb17b674d9c5cb2e441f8e196a2f048a81355d031",
      expectedFactoryCodeHash:
        "0x7b76a635c41c7b2a6bbdd9e3a5d2df9f9c662c9292f97dd9a2a847652f5f4359",
      factoryPoolIndex: 66,
      expectedRegistryId: "factory",
      factoryArrayEncoding: "legacy-fixed",
      implementationAddress: "0xa237034249290de2b07988ac64b96f22c0e76fe0",
      expectedImplementationCodeHash:
        "0xa14fbe91ed30d41ab822e2d3ef28a1ae375f3e60da77348fca77b7dd0a0b8641",
      metapool: {
        basePoolAddress: "0x7f90122bf0700f9e7e1f688fe926940e8839f353",
        expectedBasePoolCodeHash:
          "0xa3fc544c3d02269e8a5d1fef9bda368f32ed62e6da938e202549aa1b5fc520c8",
      },
    });
    expect(
      CURVE_NXUSD_METAPOOL_POLICY.executionTokens.map(
        ({ address, symbol, decimals }) => ({ address, symbol, decimals }),
      ),
    ).toEqual([
      {
        address: "0xf14f4ce569cb3679e99d5059909e23b07bd2f387",
        symbol: "NXUSD",
        decimals: 18,
      },
      {
        address: "0x47afa96cdc9fab46904a55a6ad4bf6660b53c38a",
        symbol: "avDAI",
        decimals: 18,
      },
      {
        address: "0x46a51127c3ce23fb7ab1de06226147f446e4a857",
        symbol: "avUSDC",
        decimals: 6,
      },
      {
        address: "0x532e6537fea298397212f09a61e03311686f548e",
        symbol: "avUSDT",
        decimals: 6,
      },
    ]);
  });

  it("revalidates every retained rate-bearing binding target and canonical calldata", () => {
    const target = rateTarget();
    expect(target).not.toBeNull();
    const profile = compositeProfile(
      target!,
      CURVE_DOLA_SUSDE_RATE_BEARING_POLICY,
      rateEvidence(),
    );
    expect(validateCurveCompositeProfileProof(profile)).toEqual([]);

    const expectedIssueByRole = new Map<string, string>([
      ["factory-pool-list", "factory-pool-list-proof-mismatch"],
      ["factory-coins", "factory-coins-proof-mismatch"],
      ["factory-implementation", "implementation-proof-mismatch"],
      ["pool-coin-0", "pool-coins-proof-mismatch"],
      ["pool-coin-1", "pool-coins-proof-mismatch"],
      ["token-decimals-0", "token-decimals-proof-mismatch"],
      ["token-decimals-1", "token-decimals-proof-mismatch"],
      ["factory-asset-types", "rate-provider-proof-mismatch"],
      ["rate-provider-asset", "rate-provider-proof-mismatch"],
      ["rate-provider-convert", "rate-provider-proof-mismatch"],
      ["pool-stored-rates", "rate-provider-proof-mismatch"],
    ]);
    for (const [role, expectedIssue] of expectedIssueByRole) {
      const calldataTampered = structuredClone(profile);
      calldataTampered.curveCompositeProof!.calls.find((call) => call.role === role)!.callData =
        "0x12345678";
      expect(validateCurveCompositeProfileProof(calldataTampered)).toContain(expectedIssue);

      const targetTampered = structuredClone(profile);
      targetTampered.curveCompositeProof!.calls.find((call) => call.role === role)!.target =
        "0x1111111111111111111111111111111111111111";
      expect(validateCurveCompositeProfileProof(targetTampered)).toContain(expectedIssue);
    }

    const extraCall = structuredClone(profile);
    extraCall.curveCompositeProof!.calls.push({
      ...extraCall.curveCompositeProof!.calls[0]!,
      role: "unexpected-binding",
    });
    expect(validateCurveCompositeProfileProof(extraCall)).toContain("binding-call-set-mismatch");
  });

  it("revalidates every retained metapool binding target and canonical calldata", () => {
    const target = metapoolTarget();
    expect(target).not.toBeNull();
    const profile = compositeProfile(
      target!,
      CURVE_USD1_METAPOOL_POLICY,
      metapoolEvidence(),
    );
    expect(validateCurveCompositeProfileProof(profile)).toEqual([]);

    const expectedIssueByRole = new Map<string, string>([
      ["factory-pool-list", "factory-pool-list-proof-mismatch"],
      ["factory-coins", "factory-coins-proof-mismatch"],
      ["factory-implementation", "implementation-proof-mismatch"],
      ["pool-coin-0", "pool-coins-proof-mismatch"],
      ["pool-coin-1", "pool-coins-proof-mismatch"],
      ["token-decimals-0", "token-decimals-proof-mismatch"],
      ["token-decimals-1", "token-decimals-proof-mismatch"],
      ["token-decimals-2", "token-decimals-proof-mismatch"],
      ["factory-base-pool", "metapool-path-proof-mismatch"],
      ["factory-underlying-coins", "metapool-path-proof-mismatch"],
      ["factory-underlying-decimals", "metapool-path-proof-mismatch"],
      ["factory-is-meta", "metapool-path-proof-mismatch"],
    ]);
    for (const [role, expectedIssue] of expectedIssueByRole) {
      const calldataTampered = structuredClone(profile);
      calldataTampered.curveCompositeProof!.calls.find((call) => call.role === role)!.callData =
        "0x12345678";
      expect(validateCurveCompositeProfileProof(calldataTampered)).toContain(expectedIssue);

      const targetTampered = structuredClone(profile);
      targetTampered.curveCompositeProof!.calls.find((call) => call.role === role)!.target =
        "0x1111111111111111111111111111111111111111";
      expect(validateCurveCompositeProfileProof(targetTampered)).toContain(expectedIssue);
    }
  });

  it("revalidates NXUSD legacy fixed-array factory proofs without accepting padded identities", () => {
    const target = nxusdTarget();
    expect(target).not.toBeNull();
    const profile = compositeProfile(
      target!,
      CURVE_NXUSD_METAPOOL_POLICY,
      metapoolEvidence(CURVE_NXUSD_METAPOOL_POLICY),
    );
    expect(validateCurveCompositeProfileProof(profile)).toEqual([]);

    const extraFactoryCoin = structuredClone(profile);
    extraFactoryCoin.curveCompositeProof!.calls.find(
      (call) => call.role === "factory-coins",
    )!.returnData = encodeFactoryAddresses(
      CURVE_NXUSD_METAPOOL_POLICY,
      "get_coins",
      [
        ...CURVE_NXUSD_METAPOOL_POLICY.poolTokens.map((token) => token.address),
        "0x1111111111111111111111111111111111111111",
      ],
    ).toLowerCase() as `0x${string}`;
    expect(validateCurveCompositeProfileProof(extraFactoryCoin)).toContain(
      "factory-coins-proof-mismatch",
    );

    const wrongOutputDecimals = structuredClone(profile);
    wrongOutputDecimals.curveCompositeProof!.calls.find(
      (call) => call.role === "factory-underlying-decimals",
    )!.returnData = encodeFactoryDecimals(
      CURVE_NXUSD_METAPOOL_POLICY,
      CURVE_NXUSD_METAPOOL_POLICY.executionTokens.map((token, index) =>
        BigInt(index === CURVE_NXUSD_METAPOOL_POLICY.outputIndex ? 18 : token.decimals)
      ),
    ).toLowerCase() as `0x${string}`;
    expect(validateCurveCompositeProfileProof(wrongOutputDecimals)).toContain(
      "metapool-path-proof-mismatch",
    );
  });

  it("values direct and metapool outputs from the exact raw quote", async () => {
    const directTarget = rateTarget()!;
    const metaTarget = metapoolTarget()!;
    const nxusd = nxusdTarget()!;
    const executeMulticall = vi.fn(async ({ calls: rows }: {
      chain: string;
      calls: readonly { label: string; callData: string }[];
    }) =>
      rows.map((row) => {
        const decoded = decodeFunctionData({ abi: POOL_ABI, data: row.callData as `0x${string}` });
        return {
          label: row.label,
          success: true,
          returnData: encodeFunctionResult({
            abi: POOL_ABI,
            functionName: decoded.functionName,
            result: decoded.functionName === "get_dy" ? 1_000n * 10n ** 18n : 999_000_000n,
          }).toLowerCase() as `0x${string}`,
        };
      })
    );
    const quote = createCurveCompositeQuoteExecutor({ executeMulticall });
    const outcomes = await quote({
      requests: [
        {
          target: directTarget,
          inputUsd: 1_000,
          blockNumber: BLOCK_NUMBER,
          blockObservedAt: BLOCK_TIMESTAMP + 60,
          endpointAddress: CURVE_DOLA_SUSDE_RATE_BEARING_POLICY.poolAddress,
          runtimeEvidence: rateEvidence(),
        },
        {
          target: metaTarget,
          inputUsd: 1_000,
          blockNumber: BLOCK_NUMBER,
          blockObservedAt: BLOCK_TIMESTAMP + 60,
          endpointAddress: CURVE_USD1_METAPOOL_POLICY.poolAddress,
          runtimeEvidence: metapoolEvidence(),
        },
        {
          target: nxusd,
          inputUsd: 1_000,
          blockNumber: BLOCK_NUMBER,
          blockObservedAt: BLOCK_TIMESTAMP + 60,
          endpointAddress: CURVE_NXUSD_METAPOOL_POLICY.poolAddress,
          runtimeEvidence: metapoolEvidence(CURVE_NXUSD_METAPOOL_POLICY),
        },
      ],
      chainRpcs: new Map(),
    });

    expect(outcomes).toHaveLength(3);
    expect(outcomes.every((outcome) => outcome.point != null)).toBe(true);
    expect(outcomes[0]!.point?.outputUsd).toBeGreaterThan(990);
    expect(outcomes[1]!.point?.outputUsd).toBe(999);
    expect(outcomes[2]!.point?.outputUsd).toBe(999);
    expect(executeMulticall).toHaveBeenCalledTimes(2);
    expect(executeMulticall.mock.calls.map(([call]) => call.chain)).toEqual([
      "ethereum",
      "avalanche",
    ]);
  });
});
