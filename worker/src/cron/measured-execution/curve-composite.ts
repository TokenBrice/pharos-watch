import {
  decodeFunctionData,
  decodeFunctionResult,
  encodeFunctionData,
  keccak256,
  parseAbi,
} from "viem/utils";

import { canonicalExitRouteAssetKey } from "@shared/lib/exit-route-identity";
import {
  DEX_CURVE_STABLESWAP_MEASURED_FRESHNESS_MAX_SEC,
  DEX_MEASURED_MAX_COST_BPS,
  DEX_MEASURED_TARGET_SCHEMA_VERSION,
  buildDexMeasuredExecutionTargetId,
  type DexMeasuredExecutionCurveCompositeProof,
  type DexMeasuredExecutionProfile,
  type DexMeasuredExecutionTarget,
} from "@shared/types/measured-execution";
import { throwIfAborted } from "../../lib/abort";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import {
  fetchEvmBlockHeader,
  fetchEvmCallHexAtBlock,
  fetchEvmCodeStatusAtBlock,
  fetchEvmMulticall3Aggregate3AtBlock,
  type EvmBlockHeader,
  type EvmCodeAtBlockResult,
  type EvmMulticall3Call,
  type EvmMulticall3Result,
} from "../../lib/evm-rpc";
import {
  DEX_MEASURED_EVM_REQUEST_TIMEOUT_MS,
  type DexMeasuredExecutionBudgetStopReason,
  type DexMeasuredExecutionRpcBudget,
  type DexMeasuredRawQuotePoint,
} from "./profiles";
import {
  CURVE_DOLA_SUSDE_COMPOSITE_POOL_ADDRESS,
  CURVE_USD1_COMPOSITE_POOL_ADDRESS,
} from "./curve-composite-identities";

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
const ERC20_ABI = parseAbi(["function decimals() view returns (uint8)"]);
const ERC4626_ABI = parseAbi([
  "function asset() view returns (address)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
]);
const EVM_ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const BATCH_SIZE = 8;
const MULTICALL_GAS = "0x1c9c380";

export const CURVE_RATE_BEARING_ADAPTER_PROFILE_ID =
  "curve-stableswap-ng-rate-bearing-get-dy-v1" as const;
export const CURVE_METAPOOL_ADAPTER_PROFILE_ID =
  "curve-stableswap-ng-metapool-underlying-v1" as const;

interface CurveCompositeToken {
  address: `0x${string}`;
  symbol: string;
  decimals: number;
  trackedAssetId?: string;
}

interface CurveCompositePolicyBase {
  chain: "ethereum";
  stablecoinId: string;
  adapterProfileId:
    | typeof CURVE_RATE_BEARING_ADAPTER_PROFILE_ID
    | typeof CURVE_METAPOOL_ADAPTER_PROFILE_ID;
  poolAddress: `0x${string}`;
  expectedPoolCodeHash: `0x${string}`;
  factoryAddress: `0x${string}`;
  expectedFactoryCodeHash: `0x${string}`;
  factoryPoolIndex: number;
  implementationAddress: `0x${string}`;
  expectedImplementationCodeHash: `0x${string}`;
  poolTokens: readonly [CurveCompositeToken, CurveCompositeToken];
  executionTokens: readonly CurveCompositeToken[];
  inputIndex: number;
  outputIndex: number;
  quoteFunction: "get_dy" | "get_dy_underlying";
  mode: "shadow";
  scoreEligible: false;
}

export interface CurveRateBearingPoolPolicy extends CurveCompositePolicyBase {
  adapterProfileId: typeof CURVE_RATE_BEARING_ADAPTER_PROFILE_ID;
  quoteFunction: "get_dy";
  expectedAssetTypes: readonly [0, 3];
  rateProvider: {
    kind: "erc4626";
    tokenIndex: 1;
    providerAddress: `0x${string}`;
    expectedProviderCodeHash: `0x${string}`;
    underlyingAddress: `0x${string}`;
  };
}

export interface CurveMetapoolPolicy extends CurveCompositePolicyBase {
  adapterProfileId: typeof CURVE_METAPOOL_ADAPTER_PROFILE_ID;
  quoteFunction: "get_dy_underlying";
  metapool: {
    basePoolAddress: `0x${string}`;
    expectedBasePoolCodeHash: `0x${string}`;
    basePoolTokens: readonly CurveCompositeToken[];
  };
}

export type CurveCompositePoolPolicy = CurveRateBearingPoolPolicy | CurveMetapoolPolicy;

/**
 * Exact reviewed DOLA/sUSDe StableSwap-NG deployment. The pool applies the
 * sUSDe ERC-4626 rate internally; this policy never simulates that rate.
 */
export const CURVE_DOLA_SUSDE_RATE_BEARING_POLICY: CurveRateBearingPoolPolicy = {
  chain: "ethereum",
  stablecoinId: "susde-ethena",
  adapterProfileId: CURVE_RATE_BEARING_ADAPTER_PROFILE_ID,
  poolAddress: CURVE_DOLA_SUSDE_COMPOSITE_POOL_ADDRESS,
  expectedPoolCodeHash: "0x94804f252de72c79ef819798e3149d5d461d4fbc8417aa0f5e314070c3cb599f",
  factoryAddress: "0x6a8cbed756804b16e05e741edabd5cb544ae21bf",
  expectedFactoryCodeHash: "0xb78c1b32cd364260f3fa497ccc7e98c73cdc26bdae2d3635e763ee8b59a1d6fd",
  factoryPoolIndex: 298,
  implementationAddress: "0xdcc91f930b42619377c200ba05b7513f2958b202",
  expectedImplementationCodeHash: "0xe2a3dd8d583b86eb7f562b4307aab6e5a373ddb5c6b348e4cf63d41914f35a9f",
  poolTokens: [
    {
      address: "0x865377367054516e17014ccded1e7d814edc9ce4",
      symbol: "DOLA",
      decimals: 18,
      trackedAssetId: "dola-inverse-finance",
    },
    {
      address: "0x9d39a5de30e57443bff2a8307a4256c8797a3497",
      symbol: "sUSDe",
      decimals: 18,
      trackedAssetId: "susde-ethena",
    },
  ],
  executionTokens: [
    {
      address: "0x865377367054516e17014ccded1e7d814edc9ce4",
      symbol: "DOLA",
      decimals: 18,
      trackedAssetId: "dola-inverse-finance",
    },
    {
      address: "0x9d39a5de30e57443bff2a8307a4256c8797a3497",
      symbol: "sUSDe",
      decimals: 18,
      trackedAssetId: "susde-ethena",
    },
  ],
  inputIndex: 1,
  outputIndex: 0,
  quoteFunction: "get_dy",
  expectedAssetTypes: [0, 3],
  rateProvider: {
    kind: "erc4626",
    tokenIndex: 1,
    providerAddress: "0x9d39a5de30e57443bff2a8307a4256c8797a3497",
    expectedProviderCodeHash: "0xadc4989c92fab525a1a22b3f60f5b61b77f9eb11b693e8afeba5736ea4b502e3",
    underlyingAddress: "0x4c9edd5852cd905f086c759e8383e09bff1e68b3",
  },
  mode: "shadow",
  scoreEligible: false,
};

/**
 * Exact reviewed USD1 metapool path. The executable path is USD1 -> USDC via
 * the factory-proved USDC/USDT base pool and get_dy_underlying.
 */
export const CURVE_USD1_METAPOOL_POLICY: CurveMetapoolPolicy = {
  chain: "ethereum",
  stablecoinId: "usd1-world-liberty-financial",
  adapterProfileId: CURVE_METAPOOL_ADAPTER_PROFILE_ID,
  poolAddress: CURVE_USD1_COMPOSITE_POOL_ADDRESS,
  expectedPoolCodeHash: "0x25478b25c12a81937ddb75e0c5ed8ca8ab248a102316873d092f49ca870b8cca",
  factoryAddress: "0x6a8cbed756804b16e05e741edabd5cb544ae21bf",
  expectedFactoryCodeHash: "0xb78c1b32cd364260f3fa497ccc7e98c73cdc26bdae2d3635e763ee8b59a1d6fd",
  factoryPoolIndex: 553,
  implementationAddress: "0xede71f77d7c900dca5892720e76316c6e575f0f7",
  expectedImplementationCodeHash: "0x9d37af7ff5467ed7db9fe783986e9d7dabbb9dbb5a74e1da50cea67478a584bc",
  poolTokens: [
    {
      address: "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d",
      symbol: "USD1",
      decimals: 18,
      trackedAssetId: "usd1-world-liberty-financial",
    },
    {
      address: "0x4f493b7de8aac7d55f71853688b1f7c8f0243c85",
      symbol: "crv2pool",
      decimals: 18,
    },
  ],
  executionTokens: [
    {
      address: "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d",
      symbol: "USD1",
      decimals: 18,
      trackedAssetId: "usd1-world-liberty-financial",
    },
    {
      address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      symbol: "USDC",
      decimals: 6,
      trackedAssetId: "usdc-circle",
    },
    {
      address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
      symbol: "USDT",
      decimals: 6,
      trackedAssetId: "usdt-tether",
    },
  ],
  inputIndex: 0,
  outputIndex: 1,
  quoteFunction: "get_dy_underlying",
  metapool: {
    basePoolAddress: "0x4f493b7de8aac7d55f71853688b1f7c8f0243c85",
    expectedBasePoolCodeHash: "0x5f0f1709fa823592ad75b27e32af00a8715d620dcb269be7c26fd5c873c1ce0e",
    basePoolTokens: [
      {
        address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        symbol: "USDC",
        decimals: 6,
        trackedAssetId: "usdc-circle",
      },
      {
        address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
        symbol: "USDT",
        decimals: 6,
        trackedAssetId: "usdt-tether",
      },
    ],
  },
  mode: "shadow",
  scoreEligible: false,
};

const POLICIES: readonly CurveCompositePoolPolicy[] = [
  CURVE_DOLA_SUSDE_RATE_BEARING_POLICY,
  CURVE_USD1_METAPOOL_POLICY,
];

function canonicalAddress(value: unknown): `0x${string}` | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return EVM_ADDRESS_PATTERN.test(normalized) ? (normalized as `0x${string}`) : null;
}

export function getCurveCompositePolicy(
  chain: string,
  poolAddress: string,
): CurveCompositePoolPolicy | null {
  const normalizedChain = chain.trim().toLowerCase();
  const normalizedAddress = canonicalAddress(poolAddress);
  return POLICIES.find(
    (policy) => policy.chain === normalizedChain && policy.poolAddress === normalizedAddress,
  ) ?? null;
}

export function isCurveCompositeAdapterProfileId(profileId: string): boolean {
  return profileId === CURVE_RATE_BEARING_ADAPTER_PROFILE_ID ||
    profileId === CURVE_METAPOOL_ADAPTER_PROFILE_ID;
}

interface CurveCompositePoolSource {
  poolAddress?: string;
  apiIsBroken?: boolean;
  registryId: string;
  isMetaPool: boolean;
  basePoolAddress?: string;
  poolCoins?: readonly {
    address: string;
    symbol: string;
    decimals: number;
    usdPrice: number;
    isBasePoolLpToken: boolean;
  }[];
}

/** Build one exact reviewed shadow target from the current Curve source row. */
export function buildCurveCompositeMeasuredExecutionTarget(input: {
  curveData: CurveCompositePoolSource | undefined;
  chain: string;
  stablecoinId: string;
  chainAddressToId: Map<string, string>;
  stablecoinPriceById?: Map<string, number>;
  retainedTvlUsd: number;
  capturedAt: number;
}): DexMeasuredExecutionTarget | null {
  const curveData = input.curveData;
  const policy = curveData?.poolAddress
    ? getCurveCompositePolicy(input.chain, curveData.poolAddress)
    : null;
  if (
    !curveData ||
    !policy ||
    curveData.apiIsBroken ||
    input.stablecoinId !== policy.stablecoinId ||
    curveData.registryId.trim().toLowerCase() !== "factory-stable-ng" ||
    curveData.isMetaPool !== (policy.quoteFunction === "get_dy_underlying") ||
    curveData.poolCoins?.length !== policy.poolTokens.length ||
    !Number.isFinite(input.retainedTvlUsd) ||
    input.retainedTvlUsd <= 0
  ) return null;
  if (
    policy.quoteFunction === "get_dy_underlying" &&
    canonicalAddress(curveData.basePoolAddress) !== policy.metapool.basePoolAddress
  ) return null;
  for (let index = 0; index < policy.poolTokens.length; index += 1) {
    const expected = policy.poolTokens[index]!;
    const actual = curveData.poolCoins[index]!;
    if (
      canonicalAddress(actual.address) !== expected.address ||
      actual.symbol.trim().toLowerCase() !== expected.symbol.toLowerCase() ||
      actual.decimals !== expected.decimals ||
      actual.isBasePoolLpToken !==
        (policy.quoteFunction === "get_dy_underlying" && index === 1)
    ) return null;
  }
  for (const token of policy.executionTokens) {
    if (
      token.trackedAssetId &&
      input.chainAddressToId.get(canonicalExitRouteAssetKey(policy.chain, token.address)) !==
        token.trackedAssetId
    ) return null;
  }
  const tokenIn = policy.executionTokens[policy.inputIndex];
  const tokenOut = policy.executionTokens[policy.outputIndex];
  if (!tokenIn || !tokenOut || tokenIn.trackedAssetId !== policy.stablecoinId) return null;
  const inputPrice = input.stablecoinPriceById?.get(policy.stablecoinId);
  const outputPrice = tokenOut.trackedAssetId
    ? input.stablecoinPriceById?.get(tokenOut.trackedAssetId)
    : null;
  if (
    inputPrice == null ||
    outputPrice == null ||
    !Number.isFinite(inputPrice) ||
    inputPrice <= 0 ||
    !Number.isFinite(outputPrice) ||
    outputPrice <= 0
  ) return null;
  const poolId = canonicalExitRouteAssetKey(policy.chain, policy.poolAddress);
  const poolTokenAddresses = policy.executionTokens.map((token) => token.address);
  const targetId = buildDexMeasuredExecutionTargetId({
    adapterProfileId: policy.adapterProfileId,
    stablecoinId: policy.stablecoinId,
    chain: policy.chain,
    protocol: "curve",
    poolId,
    tokenInAddress: tokenIn.address,
    tokenOutAddress: tokenOut.address,
    poolTokenAddresses,
  });
  return {
    schemaVersion: DEX_MEASURED_TARGET_SCHEMA_VERSION,
    targetId,
    stablecoinId: policy.stablecoinId,
    adapterProfileId: policy.adapterProfileId,
    protocol: "curve",
    chain: policy.chain,
    poolId,
    poolTokenAddresses,
    tokenIn: {
      address: tokenIn.address,
      symbol: tokenIn.symbol,
      decimals: tokenIn.decimals,
      referencePriceUsd: inputPrice,
      trackedAssetId: policy.stablecoinId,
    },
    tokenOut: {
      address: tokenOut.address,
      symbol: tokenOut.symbol,
      decimals: tokenOut.decimals,
      referencePriceUsd: outputPrice,
      ...(tokenOut.trackedAssetId ? { trackedAssetId: tokenOut.trackedAssetId } : {}),
    },
    retainedTvlUsd: input.retainedTvlUsd,
    retainedPoolPriceUsd: inputPrice,
    capturedAt: input.capturedAt,
  };
}

type EligibilityFailure =
  | "pool-not-reviewed"
  | "execution-endpoint-mismatch"
  | "invalid-pinned-block"
  | "block-header-unavailable"
  | "stale-pinned-block"
  | "future-pinned-block"
  | "runtime-code-unavailable"
  | "runtime-code-absent"
  | "runtime-code-hash-mismatch"
  | "factory-code-mismatch"
  | "implementation-code-mismatch"
  | "factory-membership-mismatch"
  | "pool-token-order-mismatch"
  | "token-decimals-mismatch"
  | "rate-provider-mismatch"
  | "base-pool-mismatch"
  | "rpc-failure";

export type CurveCompositeEligibility =
  | { ok: true }
  | { ok: false; reason: EligibilityFailure };

export interface CurveCompositeRuntimeEvidence {
  blockTimestamp: number;
  proof: DexMeasuredExecutionCurveCompositeProof;
}

export function evaluateCurveCompositeEligibility(input: {
  chain: string;
  endpointAddress: string;
  blockNumber: number;
  nowSec: number;
  evidence?: CurveCompositeRuntimeEvidence;
}): CurveCompositeEligibility {
  const policy = getCurveCompositePolicy(input.chain, input.endpointAddress);
  if (!policy) return { ok: false, reason: "pool-not-reviewed" };
  if (canonicalAddress(input.endpointAddress) !== policy.poolAddress) {
    return { ok: false, reason: "execution-endpoint-mismatch" };
  }
  if (!Number.isSafeInteger(input.blockNumber) || input.blockNumber < 0) {
    return { ok: false, reason: "invalid-pinned-block" };
  }
  const evidence = input.evidence;
  if (!evidence || evidence.proof.blockNumber !== input.blockNumber) {
    return { ok: false, reason: "block-header-unavailable" };
  }
  if (evidence.blockTimestamp > input.nowSec + 60) {
    return { ok: false, reason: "future-pinned-block" };
  }
  if (input.nowSec - evidence.blockTimestamp > DEX_CURVE_STABLESWAP_MEASURED_FRESHNESS_MAX_SEC) {
    return { ok: false, reason: "stale-pinned-block" };
  }
  const proof = evidence.proof;
  if (
    proof.poolCodeHash !== policy.expectedPoolCodeHash ||
    proof.registeredPoolAddress !== policy.poolAddress
  ) return { ok: false, reason: "runtime-code-hash-mismatch" };
  if (
    proof.factoryAddress !== policy.factoryAddress ||
    proof.factoryCodeHash !== policy.expectedFactoryCodeHash ||
    proof.poolIndex !== policy.factoryPoolIndex
  ) return { ok: false, reason: "factory-code-mismatch" };
  if (
    proof.implementationAddress !== policy.implementationAddress ||
    proof.implementationCodeHash !== policy.expectedImplementationCodeHash
  ) return { ok: false, reason: "implementation-code-mismatch" };
  if (
    proof.quoteFunction !== policy.quoteFunction ||
    proof.poolTokenAddresses.length !== policy.poolTokens.length ||
    proof.poolTokenAddresses.some((address, index) => address !== policy.poolTokens[index]!.address) ||
    proof.executionTokenAddresses.length !== policy.executionTokens.length ||
    proof.executionTokenAddresses.some(
      (address, index) => address !== policy.executionTokens[index]!.address,
    )
  ) return { ok: false, reason: "pool-token-order-mismatch" };
  if (policy.adapterProfileId === CURVE_RATE_BEARING_ADAPTER_PROFILE_ID) {
    if (
      !proof.rateProvider ||
      proof.rateProvider.kind !== "erc4626" ||
      proof.rateProvider.tokenAddress !== policy.poolTokens[policy.rateProvider.tokenIndex].address ||
      proof.rateProvider.providerAddress !== policy.rateProvider.providerAddress ||
      proof.rateProvider.providerCodeHash !== policy.rateProvider.expectedProviderCodeHash ||
      proof.rateProvider.underlyingAddress !== policy.rateProvider.underlyingAddress
    ) return { ok: false, reason: "rate-provider-mismatch" };
  } else if (
    !proof.metapool ||
    proof.metapool.basePoolAddress !== policy.metapool.basePoolAddress ||
    proof.metapool.basePoolCodeHash !== policy.metapool.expectedBasePoolCodeHash ||
    proof.metapool.basePoolTokenAddresses.length !== policy.metapool.basePoolTokens.length ||
    proof.metapool.basePoolTokenAddresses.some(
      (address, index) => address !== policy.metapool.basePoolTokens[index]!.address,
    )
  ) return { ok: false, reason: "base-pool-mismatch" };
  return { ok: true };
}

interface VerificationDependencies {
  fetchCodeStatus(
    chain: string,
    address: string,
    blockNumber: number,
    options: Parameters<typeof fetchEvmCodeStatusAtBlock>[3],
  ): Promise<EvmCodeAtBlockResult>;
  fetchCall(
    chain: string,
    address: string,
    callData: string,
    blockNumber: number,
    options: Parameters<typeof fetchEvmCallHexAtBlock>[4],
  ): Promise<`0x${string}` | null>;
  fetchBlockHeader(
    chain: string,
    blockNumber: number | "finalized",
    options: Parameters<typeof fetchEvmBlockHeader>[2],
  ): Promise<EvmBlockHeader | null>;
  hashCode?(code: `0x${string}`): `0x${string}`;
}

export type CurveCompositeDeploymentVerification =
  | {
      ok: true;
      codeHash: `0x${string}`;
      blockNumber: number;
      blockTimestamp: number;
      runtimeEvidence: CurveCompositeRuntimeEvidence;
      proof: DexMeasuredExecutionCurveCompositeProof;
    }
  | { ok: false; reason: EligibilityFailure };

function decodeAddress(
  abi: typeof POOL_ABI | typeof FACTORY_ABI | typeof ERC4626_ABI,
  functionName: string,
  data: `0x${string}`,
): `0x${string}` | null {
  try {
    return canonicalAddress(decodeFunctionResult({ abi, functionName, data } as never));
  } catch {
    return null;
  }
}

export function createCurveCompositeDeploymentVerifier(dependencies: VerificationDependencies) {
  return async function verifyCurveCompositeDeployment(input: {
    policy: CurveCompositePoolPolicy;
    nowSec: number;
    chainRpcs: Map<string, ChainRpcConfig>;
    signal?: AbortSignal;
    rpcBudget?: DexMeasuredExecutionRpcBudget;
  }): Promise<CurveCompositeDeploymentVerification> {
    const policy = input.policy;
    const requestOptions = {
      chainRpcs: input.chainRpcs,
      signal: input.signal,
      timeoutMs: DEX_MEASURED_EVM_REQUEST_TIMEOUT_MS,
      maxRetries: 0,
      ...(input.rpcBudget ? { deadlineMs: input.rpcBudget.deadlineMs } : {}),
      ...(input.rpcBudget ? { beforeRequest: () => input.rpcBudget!.tryConsume() } : {}),
    };
    const header = await dependencies.fetchBlockHeader(policy.chain, "finalized", requestOptions);
    input.rpcBudget?.recordChainResult(policy.chain, header != null);
    if (!header) return { ok: false, reason: "block-header-unavailable" };
    if (header.timestamp > input.nowSec + 60) return { ok: false, reason: "future-pinned-block" };
    if (input.nowSec - header.timestamp > DEX_CURVE_STABLESWAP_MEASURED_FRESHNESS_MAX_SEC) {
      return { ok: false, reason: "stale-pinned-block" };
    }

    const hashCode = dependencies.hashCode ?? ((code: `0x${string}`) => keccak256(code));
    const readCode = async (
      address: `0x${string}`,
    ): Promise<{ ok: true; hash: `0x${string}` } | { ok: false; absent: boolean }> => {
      throwIfAborted(input.signal);
      if (input.rpcBudget && !input.rpcBudget.canRequestChain(policy.chain)) {
        return { ok: false, absent: false };
      }
      const result = await dependencies.fetchCodeStatus(
        policy.chain,
        address,
        header.number,
        requestOptions,
      );
      input.rpcBudget?.recordChainResult(policy.chain, result.status !== "unavailable");
      return result.status === "available"
        ? { ok: true, hash: hashCode(result.code).toLowerCase() as `0x${string}` }
        : { ok: false, absent: result.status === "absent" };
    };
    const calls: DexMeasuredExecutionCurveCompositeProof["calls"] = [];
    const readCall = async (
      role: string,
      target: `0x${string}`,
      callData: `0x${string}`,
    ): Promise<`0x${string}` | null> => {
      throwIfAborted(input.signal);
      if (input.rpcBudget && !input.rpcBudget.canRequestChain(policy.chain)) return null;
      const result = await dependencies.fetchCall(
        policy.chain,
        target,
        callData,
        header.number,
        requestOptions,
      );
      input.rpcBudget?.recordChainResult(policy.chain, result != null);
      if (result != null) {
        calls.push({
          role,
          target,
          callData,
          returnData: result.toLowerCase() as `0x${string}`,
        });
      }
      return result;
    };

    const poolCode = await readCode(policy.poolAddress);
    if (!poolCode.ok) {
      return { ok: false, reason: poolCode.absent ? "runtime-code-absent" : "runtime-code-unavailable" };
    }
    if (poolCode.hash !== policy.expectedPoolCodeHash) {
      return { ok: false, reason: "runtime-code-hash-mismatch" };
    }
    const factoryCode = await readCode(policy.factoryAddress);
    if (!factoryCode.ok || factoryCode.hash !== policy.expectedFactoryCodeHash) {
      return { ok: false, reason: "factory-code-mismatch" };
    }
    const implementationCode = await readCode(policy.implementationAddress);
    if (!implementationCode.ok || implementationCode.hash !== policy.expectedImplementationCodeHash) {
      return { ok: false, reason: "implementation-code-mismatch" };
    }

    const poolListData = encodeFunctionData({
      abi: FACTORY_ABI,
      functionName: "pool_list",
      args: [BigInt(policy.factoryPoolIndex)],
    }).toLowerCase() as `0x${string}`;
    const factoryCoinsData = encodeFunctionData({
      abi: FACTORY_ABI,
      functionName: "get_coins",
      args: [policy.poolAddress],
    }).toLowerCase() as `0x${string}`;
    const implementationData = encodeFunctionData({
      abi: FACTORY_ABI,
      functionName: "get_implementation_address",
      args: [policy.poolAddress],
    }).toLowerCase() as `0x${string}`;
    const [poolListResult, factoryCoinsResult, implementationResult] = [
      await readCall("factory-pool-list", policy.factoryAddress, poolListData),
      await readCall("factory-coins", policy.factoryAddress, factoryCoinsData),
      await readCall("factory-implementation", policy.factoryAddress, implementationData),
    ];
    if (!poolListResult || !factoryCoinsResult || !implementationResult) {
      return { ok: false, reason: "rpc-failure" };
    }
    let factoryCoins: readonly string[];
    try {
      factoryCoins = decodeFunctionResult({
        abi: FACTORY_ABI,
        functionName: "get_coins",
        data: factoryCoinsResult,
      }) as readonly string[];
    } catch {
      return { ok: false, reason: "factory-membership-mismatch" };
    }
    if (
      decodeAddress(FACTORY_ABI, "pool_list", poolListResult) !== policy.poolAddress ||
      decodeAddress(FACTORY_ABI, "get_implementation_address", implementationResult) !==
        policy.implementationAddress ||
      factoryCoins.length !== policy.poolTokens.length ||
      factoryCoins.some(
        (address, index) => canonicalAddress(address) !== policy.poolTokens[index]!.address,
      )
    ) return { ok: false, reason: "factory-membership-mismatch" };

    for (let index = 0; index < policy.poolTokens.length; index += 1) {
      throwIfAborted(input.signal);
      const callData = encodeFunctionData({
        abi: POOL_ABI,
        functionName: "coins",
        args: [BigInt(index)],
      }).toLowerCase() as `0x${string}`;
      const result = await readCall(`pool-coin-${index}`, policy.poolAddress, callData);
      if (!result || decodeAddress(POOL_ABI, "coins", result) !== policy.poolTokens[index]!.address) {
        return { ok: false, reason: "pool-token-order-mismatch" };
      }
    }
    for (let index = 0; index < policy.executionTokens.length; index += 1) {
      throwIfAborted(input.signal);
      const token = policy.executionTokens[index]!;
      const callData = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "decimals",
      }).toLowerCase() as `0x${string}`;
      const result = await readCall(`token-decimals-${index}`, token.address, callData);
      if (!result) return { ok: false, reason: "token-decimals-mismatch" };
      try {
        if (
          Number(decodeFunctionResult({
            abi: ERC20_ABI,
            functionName: "decimals",
            data: result,
          })) !== token.decimals
        ) return { ok: false, reason: "token-decimals-mismatch" };
      } catch {
        return { ok: false, reason: "token-decimals-mismatch" };
      }
    }

    let rateProvider: DexMeasuredExecutionCurveCompositeProof["rateProvider"];
    let metapool: DexMeasuredExecutionCurveCompositeProof["metapool"];
    if (policy.adapterProfileId === CURVE_RATE_BEARING_ADAPTER_PROFILE_ID) {
      const providerCode = await readCode(policy.rateProvider.providerAddress);
      if (!providerCode.ok || providerCode.hash !== policy.rateProvider.expectedProviderCodeHash) {
        return { ok: false, reason: "rate-provider-mismatch" };
      }
      const assetTypesData = encodeFunctionData({
        abi: FACTORY_ABI,
        functionName: "get_pool_asset_types",
        args: [policy.poolAddress],
      }).toLowerCase() as `0x${string}`;
      const assetData = encodeFunctionData({
        abi: ERC4626_ABI,
        functionName: "asset",
      }).toLowerCase() as `0x${string}`;
      const shares = 10n ** BigInt(policy.poolTokens[policy.rateProvider.tokenIndex].decimals);
      const convertData = encodeFunctionData({
        abi: ERC4626_ABI,
        functionName: "convertToAssets",
        args: [shares],
      }).toLowerCase() as `0x${string}`;
      const storedRatesData = encodeFunctionData({
        abi: POOL_ABI,
        functionName: "stored_rates",
      }).toLowerCase() as `0x${string}`;
      const [assetTypesResult, assetResult, convertResult, storedRatesResult] = [
        await readCall("factory-asset-types", policy.factoryAddress, assetTypesData),
        await readCall("rate-provider-asset", policy.rateProvider.providerAddress, assetData),
        await readCall("rate-provider-convert", policy.rateProvider.providerAddress, convertData),
        await readCall("pool-stored-rates", policy.poolAddress, storedRatesData),
      ];
      if (!assetTypesResult || !assetResult || !convertResult || !storedRatesResult) {
        return { ok: false, reason: "rate-provider-mismatch" };
      }
      try {
        const assetTypes = decodeFunctionResult({
          abi: FACTORY_ABI,
          functionName: "get_pool_asset_types",
          data: assetTypesResult,
        }) as readonly number[];
        const observedRate = decodeFunctionResult({
          abi: ERC4626_ABI,
          functionName: "convertToAssets",
          data: convertResult,
        }) as bigint;
        const storedRates = decodeFunctionResult({
          abi: POOL_ABI,
          functionName: "stored_rates",
          data: storedRatesResult,
        }) as readonly bigint[];
        if (
          assetTypes.length !== policy.expectedAssetTypes.length ||
          assetTypes.some((value, index) => Number(value) !== policy.expectedAssetTypes[index]) ||
          decodeAddress(ERC4626_ABI, "asset", assetResult) !== policy.rateProvider.underlyingAddress ||
          observedRate <= 0n ||
          storedRates.length !== policy.poolTokens.length ||
          storedRates[policy.rateProvider.tokenIndex] !== observedRate
        ) return { ok: false, reason: "rate-provider-mismatch" };
        rateProvider = {
          kind: "erc4626",
          tokenAddress: policy.poolTokens[policy.rateProvider.tokenIndex].address,
          providerAddress: policy.rateProvider.providerAddress,
          providerCodeHash: providerCode.hash,
          underlyingAddress: policy.rateProvider.underlyingAddress,
          observedRate: observedRate.toString(),
        };
      } catch {
        return { ok: false, reason: "rate-provider-mismatch" };
      }
    } else {
      const baseCode = await readCode(policy.metapool.basePoolAddress);
      if (!baseCode.ok || baseCode.hash !== policy.metapool.expectedBasePoolCodeHash) {
        return { ok: false, reason: "base-pool-mismatch" };
      }
      const basePoolData = encodeFunctionData({
        abi: FACTORY_ABI,
        functionName: "get_base_pool",
        args: [policy.poolAddress],
      }).toLowerCase() as `0x${string}`;
      const underlyingCoinsData = encodeFunctionData({
        abi: FACTORY_ABI,
        functionName: "get_underlying_coins",
        args: [policy.poolAddress],
      }).toLowerCase() as `0x${string}`;
      const underlyingDecimalsData = encodeFunctionData({
        abi: FACTORY_ABI,
        functionName: "get_underlying_decimals",
        args: [policy.poolAddress],
      }).toLowerCase() as `0x${string}`;
      const isMetaData = encodeFunctionData({
        abi: FACTORY_ABI,
        functionName: "is_meta",
        args: [policy.poolAddress],
      }).toLowerCase() as `0x${string}`;
      const [basePoolResult, underlyingCoinsResult, underlyingDecimalsResult, isMetaResult] = [
        await readCall("factory-base-pool", policy.factoryAddress, basePoolData),
        await readCall("factory-underlying-coins", policy.factoryAddress, underlyingCoinsData),
        await readCall("factory-underlying-decimals", policy.factoryAddress, underlyingDecimalsData),
        await readCall("factory-is-meta", policy.factoryAddress, isMetaData),
      ];
      if (!basePoolResult || !underlyingCoinsResult || !underlyingDecimalsResult || !isMetaResult) {
        return { ok: false, reason: "base-pool-mismatch" };
      }
      try {
        const underlyingCoins = decodeFunctionResult({
          abi: FACTORY_ABI,
          functionName: "get_underlying_coins",
          data: underlyingCoinsResult,
        }) as readonly string[];
        const underlyingDecimals = decodeFunctionResult({
          abi: FACTORY_ABI,
          functionName: "get_underlying_decimals",
          data: underlyingDecimalsResult,
        }) as readonly bigint[];
        const isMeta = decodeFunctionResult({
          abi: FACTORY_ABI,
          functionName: "is_meta",
          data: isMetaResult,
        }) as boolean;
        if (
          decodeAddress(FACTORY_ABI, "get_base_pool", basePoolResult) !== policy.metapool.basePoolAddress ||
          !isMeta ||
          underlyingCoins.length !== policy.executionTokens.length ||
          underlyingCoins.some(
            (address, index) => canonicalAddress(address) !== policy.executionTokens[index]!.address,
          ) ||
          underlyingDecimals.length !== policy.executionTokens.length ||
          underlyingDecimals.some(
            (decimals, index) => Number(decimals) !== policy.executionTokens[index]!.decimals,
          )
        ) return { ok: false, reason: "base-pool-mismatch" };
        metapool = {
          basePoolAddress: policy.metapool.basePoolAddress,
          basePoolCodeHash: baseCode.hash,
          basePoolTokenAddresses: policy.metapool.basePoolTokens.map((token) => token.address),
        };
      } catch {
        return { ok: false, reason: "base-pool-mismatch" };
      }
    }

    const revalidated = await dependencies.fetchBlockHeader(policy.chain, header.number, requestOptions);
    input.rpcBudget?.recordChainResult(policy.chain, revalidated != null);
    if (
      !revalidated ||
      revalidated.hash !== header.hash ||
      revalidated.timestamp !== header.timestamp
    ) return { ok: false, reason: "block-header-unavailable" };

    const proof: DexMeasuredExecutionCurveCompositeProof = {
      blockNumber: header.number,
      blockHash: header.hash,
      blockCommitment: "finalized",
      factoryAddress: policy.factoryAddress,
      factoryCodeHash: factoryCode.hash,
      poolIndex: policy.factoryPoolIndex,
      registeredPoolAddress: policy.poolAddress,
      poolCodeHash: poolCode.hash,
      implementationAddress: policy.implementationAddress,
      implementationCodeHash: implementationCode.hash,
      quoteFunction: policy.quoteFunction,
      poolTokenAddresses: policy.poolTokens.map((token) => token.address),
      executionTokenAddresses: policy.executionTokens.map((token) => token.address),
      calls,
      ...(rateProvider ? { rateProvider } : {}),
      ...(metapool ? { metapool } : {}),
    };
    const runtimeEvidence = { blockTimestamp: header.timestamp, proof };
    const eligibility = evaluateCurveCompositeEligibility({
      chain: policy.chain,
      endpointAddress: policy.poolAddress,
      blockNumber: header.number,
      nowSec: input.nowSec,
      evidence: runtimeEvidence,
    });
    return eligibility.ok
      ? {
          ok: true,
          codeHash: poolCode.hash,
          blockNumber: header.number,
          blockTimestamp: header.timestamp,
          runtimeEvidence,
          proof,
        }
      : eligibility;
  };
}

export const verifyCurveCompositeDeployment = createCurveCompositeDeploymentVerifier({
  fetchCodeStatus: fetchEvmCodeStatusAtBlock,
  fetchCall: fetchEvmCallHexAtBlock,
  fetchBlockHeader: fetchEvmBlockHeader,
});

type QuoteFailure =
  | DexMeasuredExecutionBudgetStopReason
  | "unsupported-chain-or-pool"
  | "invalid-pinned-block"
  | "invalid-quote-input"
  | "invalid-curve-composite-target"
  | "runtime-evidence-missing"
  | "rpc-failure"
  | "pool-revert"
  | "malformed-pool-return";

export interface CurveCompositeRequest {
  target: DexMeasuredExecutionTarget;
  inputUsd: number;
  blockNumber: number;
  blockObservedAt: number;
  endpointAddress: `0x${string}`;
  runtimeEvidence?: CurveCompositeRuntimeEvidence;
}

interface EncodedRequest extends CurveCompositeRequest {
  index: number;
  label: string;
  amountInRaw: bigint;
  inputIndex: number;
  outputIndex: number;
  callData: `0x${string}`;
  policy: CurveCompositePoolPolicy;
  eligibility: CurveCompositeEligibility;
}

export interface CurveCompositeBatchOutcome {
  targetId: string;
  inputUsd: number;
  blockNumber: number;
  eligibility: CurveCompositeEligibility;
  point?: DexMeasuredRawQuotePoint;
  failureReason?: QuoteFailure;
}

function usdToRawAmount(inputUsd: number, decimals: number, referencePriceUsd: number): bigint | null {
  if (
    !Number.isFinite(inputUsd) ||
    inputUsd <= 0 ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 255 ||
    !Number.isFinite(referencePriceUsd) ||
    referencePriceUsd <= 0
  ) return null;
  const usdScale = 1_000_000n;
  const priceScale = 100_000_000n;
  const usdScaled = BigInt(Math.floor(inputUsd * Number(usdScale)));
  const priceScaled = BigInt(Math.round(referencePriceUsd * Number(priceScale)));
  if (priceScaled <= 0n) return null;
  const amount = (usdScaled * 10n ** BigInt(decimals) * priceScale) / (usdScale * priceScaled);
  return amount > 0n ? amount : null;
}

function rawAmountToUsd(amount: bigint, decimals: number, referencePriceUsd: number): number | null {
  if (amount < 0n || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) return null;
  const priceScale = 100_000_000n;
  const usdScale = 1_000_000n;
  const priceScaled = BigInt(Math.round(referencePriceUsd * Number(priceScale)));
  if (priceScaled <= 0n) return null;
  const usdScaled = amount * priceScaled * usdScale / (10n ** BigInt(decimals) * priceScale);
  const usd = Number(usdScaled) / Number(usdScale);
  return Number.isFinite(usd) && usd >= 0 ? usd : null;
}

export function resolveCurveCompositeTokenIndices(
  target: DexMeasuredExecutionTarget | DexMeasuredExecutionProfile,
): { ok: true; inputIndex: number; outputIndex: number } | { ok: false; reason: QuoteFailure } {
  const endpointAddress =
    "executionEndpoint" in target
      ? target.executionEndpoint.address
      : target.poolId.slice(target.poolId.lastIndexOf(":") + 1);
  const policy = getCurveCompositePolicy(target.chain, endpointAddress);
  if (
    !policy ||
    target.adapterProfileId !== policy.adapterProfileId ||
    target.protocol.trim().toLowerCase() !== "curve" ||
    target.tokenIn.trackedAssetId !== policy.stablecoinId ||
    target.poolTokenAddresses?.length !== policy.executionTokens.length ||
    target.poolTokenAddresses.some(
      (address, index) => address !== policy.executionTokens[index]!.address,
    ) ||
    target.tokenIn.address !== policy.executionTokens[policy.inputIndex]?.address ||
    target.tokenOut.address !== policy.executionTokens[policy.outputIndex]?.address ||
    target.tokenIn.decimals !== policy.executionTokens[policy.inputIndex]?.decimals ||
    target.tokenOut.decimals !== policy.executionTokens[policy.outputIndex]?.decimals
  ) return { ok: false, reason: "invalid-curve-composite-target" };
  return { ok: true, inputIndex: policy.inputIndex, outputIndex: policy.outputIndex };
}

export function encodeCurveCompositeQuote(input: {
  policy: CurveCompositePoolPolicy;
  inputIndex: number;
  outputIndex: number;
  amountInRaw: bigint;
}): `0x${string}` {
  if (
    input.inputIndex !== input.policy.inputIndex ||
    input.outputIndex !== input.policy.outputIndex ||
    input.amountInRaw <= 0n
  ) throw new Error("Curve composite quote indices or amount are invalid");
  return encodeFunctionData({
    abi: POOL_ABI,
    functionName: input.policy.quoteFunction,
    args: [BigInt(input.inputIndex), BigInt(input.outputIndex), input.amountInRaw],
  }).toLowerCase() as `0x${string}`;
}

function decodeCurveCompositeQuote(
  policy: CurveCompositePoolPolicy,
  returnData: `0x${string}`,
): bigint | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(returnData)) return null;
  try {
    return decodeFunctionResult({
      abi: POOL_ABI,
      functionName: policy.quoteFunction,
      data: returnData,
    }) as bigint;
  } catch {
    return null;
  }
}

function prepareRequest(
  request: CurveCompositeRequest,
  index: number,
): {
  encoded?: EncodedRequest;
  failureReason?: QuoteFailure;
  eligibility: CurveCompositeEligibility;
} {
  const policy = getCurveCompositePolicy(request.target.chain, request.endpointAddress);
  const eligibility = evaluateCurveCompositeEligibility({
    chain: request.target.chain,
    endpointAddress: request.endpointAddress,
    blockNumber: request.blockNumber,
    nowSec: request.blockObservedAt,
    evidence: request.runtimeEvidence,
  });
  if (!policy) return { failureReason: "unsupported-chain-or-pool", eligibility };
  if (!Number.isSafeInteger(request.blockNumber) || request.blockNumber < 0) {
    return { failureReason: "invalid-pinned-block", eligibility };
  }
  if (!eligibility.ok) return { failureReason: "runtime-evidence-missing", eligibility };
  const indices = resolveCurveCompositeTokenIndices(request.target);
  if (!indices.ok) return { failureReason: indices.reason, eligibility };
  const expectedTargetId = buildDexMeasuredExecutionTargetId({
    adapterProfileId: request.target.adapterProfileId,
    stablecoinId: request.target.stablecoinId,
    chain: request.target.chain,
    protocol: request.target.protocol,
    poolId: request.target.poolId,
    tokenInAddress: request.target.tokenIn.address,
    tokenOutAddress: request.target.tokenOut.address,
    poolTokenAddresses: request.target.poolTokenAddresses,
  });
  if (request.target.targetId !== expectedTargetId) {
    return { failureReason: "invalid-curve-composite-target", eligibility };
  }
  const amountInRaw = usdToRawAmount(
    request.inputUsd,
    request.target.tokenIn.decimals,
    request.target.tokenIn.referencePriceUsd,
  );
  if (!amountInRaw) return { failureReason: "invalid-quote-input", eligibility };
  return {
    eligibility,
    encoded: {
      ...request,
      index,
      label: `${index}:${request.target.targetId}`,
      amountInRaw,
      inputIndex: indices.inputIndex,
      outputIndex: indices.outputIndex,
      callData: encodeCurveCompositeQuote({
        policy,
        inputIndex: indices.inputIndex,
        outputIndex: indices.outputIndex,
        amountInRaw,
      }),
      policy,
      eligibility,
    },
  };
}

function decodeQuotePoint(
  request: EncodedRequest,
  result: EvmMulticall3Result,
): { point?: DexMeasuredRawQuotePoint; failureReason?: QuoteFailure } {
  if (!result.success) return { failureReason: "pool-revert" };
  const amountOutRaw = decodeCurveCompositeQuote(request.policy, result.returnData);
  if (amountOutRaw == null) return { failureReason: "malformed-pool-return" };
  const inputUsd = rawAmountToUsd(
    request.amountInRaw,
    request.target.tokenIn.decimals,
    request.target.tokenIn.referencePriceUsd,
  );
  const outputUsd = rawAmountToUsd(
    amountOutRaw,
    request.target.tokenOut.decimals,
    request.target.tokenOut.referencePriceUsd,
  );
  if (inputUsd == null || inputUsd <= 0 || outputUsd == null) {
    return { failureReason: "malformed-pool-return" };
  }
  const costBps = Math.max(0, (1 - outputUsd / inputUsd) * 10_000);
  return {
    point: {
      amountInRaw: request.amountInRaw.toString(),
      amountOutRaw: amountOutRaw.toString(),
      callData: request.callData,
      returnData: result.returnData.toLowerCase() as `0x${string}`,
      inputUsd,
      outputUsd,
      costBps,
      passesCostBound: costBps <= DEX_MEASURED_MAX_COST_BPS,
      adapterMetadata: {
        executionPool: request.endpointAddress,
        blockNumber: request.blockNumber,
        inputIndex: request.inputIndex,
        outputIndex: request.outputIndex,
        quoteFunction: request.policy.quoteFunction,
      },
    },
  };
}

interface QuoteDependencies {
  executeMulticall(input: {
    chain: string;
    calls: readonly EvmMulticall3Call[];
    blockNumber: number;
    chainRpcs: Map<string, ChainRpcConfig>;
    signal?: AbortSignal;
    rpcBudget?: DexMeasuredExecutionRpcBudget;
  }): Promise<EvmMulticall3Result[] | null>;
}

export function createCurveCompositeQuoteExecutor(dependencies: QuoteDependencies) {
  return async function quoteCurveCompositeRequests(input: {
    requests: readonly CurveCompositeRequest[];
    chainRpcs: Map<string, ChainRpcConfig>;
    signal?: AbortSignal;
    rpcBudget?: DexMeasuredExecutionRpcBudget;
  }): Promise<CurveCompositeBatchOutcome[]> {
    const prepared = input.requests.map(prepareRequest);
    const outcomes = input.requests.map((request, index): CurveCompositeBatchOutcome => ({
      targetId: request.target.targetId,
      inputUsd: request.inputUsd,
      blockNumber: request.blockNumber,
      eligibility: prepared[index]!.eligibility,
      ...(prepared[index]!.failureReason ? { failureReason: prepared[index]!.failureReason } : {}),
    }));
    const valid = prepared.flatMap((entry) => entry.encoded ? [entry.encoded] : []);
    for (let offset = 0; offset < valid.length; offset += BATCH_SIZE) {
      throwIfAborted(input.signal);
      const chunk = valid.slice(offset, offset + BATCH_SIZE);
      const results = await dependencies.executeMulticall({
        chain: chunk[0]!.policy.chain,
        calls: chunk.map((request) => ({
          label: request.label,
          target: request.endpointAddress,
          callData: request.callData,
          allowFailure: true,
        })),
        blockNumber: chunk[0]!.blockNumber,
        chainRpcs: input.chainRpcs,
        signal: input.signal,
        rpcBudget: input.rpcBudget,
      });
      input.rpcBudget?.recordChainResult(chunk[0]!.policy.chain, results != null);
      const byLabel = new Map((results ?? []).map((result) => [result.label, result]));
      for (const request of chunk) {
        const result = byLabel.get(request.label);
        outcomes[request.index] = {
          targetId: request.target.targetId,
          inputUsd: request.inputUsd,
          blockNumber: request.blockNumber,
          eligibility: request.eligibility,
          ...(result
            ? decodeQuotePoint(request, result)
            : { failureReason: input.rpcBudget?.stopReason ?? "rpc-failure" }),
        };
      }
    }
    return outcomes;
  };
}

export const quoteCurveCompositeRequests = createCurveCompositeQuoteExecutor({
  executeMulticall: async (input) =>
    fetchEvmMulticall3Aggregate3AtBlock(input.chain, input.calls, input.blockNumber, {
      chainRpcs: input.chainRpcs,
      signal: input.signal,
      timeoutMs: DEX_MEASURED_EVM_REQUEST_TIMEOUT_MS,
      maxRetries: 1,
      ...(input.rpcBudget ? { deadlineMs: input.rpcBudget.deadlineMs } : {}),
      ...(input.rpcBudget ? { beforeRequest: () => input.rpcBudget!.tryConsume() } : {}),
      gas: MULTICALL_GAS,
      multicallBatchSize: Math.min(BATCH_SIZE, input.calls.length),
    }),
});

function callByRole(
  proof: DexMeasuredExecutionCurveCompositeProof,
  role: string,
): DexMeasuredExecutionCurveCompositeProof["calls"][number] | null {
  const matches = proof.calls.filter((call) => call.role === role);
  return matches.length === 1 ? matches[0]! : null;
}

function bindingCallMatches(
  call: DexMeasuredExecutionCurveCompositeProof["calls"][number] | null,
  target: `0x${string}`,
  callData: `0x${string}`,
): call is DexMeasuredExecutionCurveCompositeProof["calls"][number] {
  return call?.target === target && call.callData === callData;
}

/** Consumer-side raw-call and decoded-identity validation. */
export function validateCurveCompositeProfileProof(profile: DexMeasuredExecutionProfile): string[] {
  const issues = new Set<string>();
  const policy = getCurveCompositePolicy(profile.chain, profile.executionEndpoint.address);
  if (!policy || profile.adapterProfileId !== policy.adapterProfileId) {
    return ["execution-pool-not-reviewed"];
  }
  const indices = resolveCurveCompositeTokenIndices(profile);
  if (!indices.ok) issues.add(indices.reason);
  const proof = profile.curveCompositeProof;
  if (!proof) return ["curve-composite-proof-missing", ...issues];
  const eligibility = evaluateCurveCompositeEligibility({
    chain: profile.chain,
    endpointAddress: profile.executionEndpoint.address,
    blockNumber: profile.blockNumber,
    nowSec: profile.quotedAt,
    evidence: { blockTimestamp: profile.quotedAt, proof },
  });
  if (!eligibility.ok) issues.add(eligibility.reason);
  if (
    profile.executionEndpoint.codeHash !== policy.expectedPoolCodeHash ||
    proof.blockNumber !== profile.blockNumber
  ) issues.add("endpoint-binding-mismatch");

  const commonRoles = [
    "factory-pool-list",
    "factory-coins",
    "factory-implementation",
    ...policy.poolTokens.map((_, index) => `pool-coin-${index}`),
    ...policy.executionTokens.map((_, index) => `token-decimals-${index}`),
  ];
  const policyRoles = policy.adapterProfileId === CURVE_RATE_BEARING_ADAPTER_PROFILE_ID
    ? [
        "factory-asset-types",
        "rate-provider-asset",
        "rate-provider-convert",
        "pool-stored-rates",
      ]
    : [
        "factory-base-pool",
        "factory-underlying-coins",
        "factory-underlying-decimals",
        "factory-is-meta",
      ];
  const expectedRoles = [...commonRoles, ...policyRoles];
  if (
    proof.calls.length !== expectedRoles.length ||
    proof.calls.some((call) => !expectedRoles.includes(call.role)) ||
    expectedRoles.some(
      (role) => proof.calls.filter((call) => call.role === role).length !== 1,
    )
  ) issues.add("binding-call-set-mismatch");

  const poolList = callByRole(proof, "factory-pool-list");
  const factoryCoins = callByRole(proof, "factory-coins");
  const implementation = callByRole(proof, "factory-implementation");
  const poolListCallData = encodeFunctionData({
    abi: FACTORY_ABI,
    functionName: "pool_list",
    args: [BigInt(policy.factoryPoolIndex)],
  }).toLowerCase() as `0x${string}`;
  const factoryCoinsCallData = encodeFunctionData({
    abi: FACTORY_ABI,
    functionName: "get_coins",
    args: [policy.poolAddress],
  }).toLowerCase() as `0x${string}`;
  const implementationCallData = encodeFunctionData({
    abi: FACTORY_ABI,
    functionName: "get_implementation_address",
    args: [policy.poolAddress],
  }).toLowerCase() as `0x${string}`;
  try {
    if (
      !bindingCallMatches(poolList, policy.factoryAddress, poolListCallData) ||
      decodeAddress(FACTORY_ABI, "pool_list", poolList.returnData as `0x${string}`) !==
        policy.poolAddress
    ) issues.add("factory-pool-list-proof-mismatch");
  } catch {
    issues.add("factory-pool-list-proof-mismatch");
  }
  try {
    const decoded = factoryCoins
      ? decodeFunctionResult({
          abi: FACTORY_ABI,
          functionName: "get_coins",
          data: factoryCoins.returnData as `0x${string}`,
        }) as readonly string[]
      : [];
    if (
      !bindingCallMatches(factoryCoins, policy.factoryAddress, factoryCoinsCallData) ||
      decoded.length !== policy.poolTokens.length ||
      decoded.some(
        (address, index) => canonicalAddress(address) !== policy.poolTokens[index]!.address,
      )
    ) issues.add("factory-coins-proof-mismatch");
  } catch {
    issues.add("factory-coins-proof-mismatch");
  }
  if (
    !bindingCallMatches(implementation, policy.factoryAddress, implementationCallData) ||
    decodeAddress(
      FACTORY_ABI,
      "get_implementation_address",
      implementation.returnData as `0x${string}`,
    ) !== policy.implementationAddress
  ) issues.add("implementation-proof-mismatch");

  for (let index = 0; index < policy.poolTokens.length; index += 1) {
    const call = callByRole(proof, `pool-coin-${index}`);
    const callData = encodeFunctionData({
      abi: POOL_ABI,
      functionName: "coins",
      args: [BigInt(index)],
    }).toLowerCase() as `0x${string}`;
    if (
      !bindingCallMatches(call, policy.poolAddress, callData) ||
      decodeAddress(POOL_ABI, "coins", call.returnData as `0x${string}`) !==
        policy.poolTokens[index]!.address
    ) issues.add("pool-coins-proof-mismatch");
  }
  for (let index = 0; index < policy.executionTokens.length; index += 1) {
    const call = callByRole(proof, `token-decimals-${index}`);
    const callData = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "decimals",
    }).toLowerCase() as `0x${string}`;
    try {
      if (
        !bindingCallMatches(call, policy.executionTokens[index]!.address, callData) ||
        Number(decodeFunctionResult({
          abi: ERC20_ABI,
          functionName: "decimals",
          data: call.returnData as `0x${string}`,
        })) !== policy.executionTokens[index]!.decimals
      ) issues.add("token-decimals-proof-mismatch");
    } catch {
      issues.add("token-decimals-proof-mismatch");
    }
  }
  if (policy.adapterProfileId === CURVE_RATE_BEARING_ADAPTER_PROFILE_ID) {
    const assetTypes = callByRole(proof, "factory-asset-types");
    const asset = callByRole(proof, "rate-provider-asset");
    const convert = callByRole(proof, "rate-provider-convert");
    const storedRates = callByRole(proof, "pool-stored-rates");
    const assetTypesCallData = encodeFunctionData({
      abi: FACTORY_ABI,
      functionName: "get_pool_asset_types",
      args: [policy.poolAddress],
    }).toLowerCase() as `0x${string}`;
    const assetCallData = encodeFunctionData({
      abi: ERC4626_ABI,
      functionName: "asset",
    }).toLowerCase() as `0x${string}`;
    const shares = 10n ** BigInt(policy.poolTokens[policy.rateProvider.tokenIndex].decimals);
    const convertCallData = encodeFunctionData({
      abi: ERC4626_ABI,
      functionName: "convertToAssets",
      args: [shares],
    }).toLowerCase() as `0x${string}`;
    const storedRatesCallData = encodeFunctionData({
      abi: POOL_ABI,
      functionName: "stored_rates",
    }).toLowerCase() as `0x${string}`;
    try {
      const observedAssetTypes = assetTypes
        ? decodeFunctionResult({
            abi: FACTORY_ABI,
            functionName: "get_pool_asset_types",
            data: assetTypes.returnData as `0x${string}`,
          }) as readonly number[]
        : [];
      const observedRate = convert
        ? decodeFunctionResult({
            abi: ERC4626_ABI,
            functionName: "convertToAssets",
            data: convert.returnData as `0x${string}`,
          }) as bigint
        : 0n;
      const rates = storedRates
        ? decodeFunctionResult({
            abi: POOL_ABI,
            functionName: "stored_rates",
            data: storedRates.returnData as `0x${string}`,
          }) as readonly bigint[]
        : [];
      if (
        !bindingCallMatches(assetTypes, policy.factoryAddress, assetTypesCallData) ||
        !bindingCallMatches(asset, policy.rateProvider.providerAddress, assetCallData) ||
        !bindingCallMatches(convert, policy.rateProvider.providerAddress, convertCallData) ||
        !bindingCallMatches(storedRates, policy.poolAddress, storedRatesCallData) ||
        observedAssetTypes.length !== policy.expectedAssetTypes.length ||
        observedAssetTypes.some(
          (value, index) => Number(value) !== policy.expectedAssetTypes[index],
        ) ||
        decodeAddress(ERC4626_ABI, "asset", asset.returnData as `0x${string}`) !==
          policy.rateProvider.underlyingAddress ||
        observedRate <= 0n ||
        observedRate.toString() !== proof.rateProvider?.observedRate ||
        rates.length !== policy.poolTokens.length ||
        rates[policy.rateProvider.tokenIndex] !== observedRate
      ) issues.add("rate-provider-proof-mismatch");
    } catch {
      issues.add("rate-provider-proof-mismatch");
    }
  } else {
    const basePool = callByRole(proof, "factory-base-pool");
    const underlyingCoins = callByRole(proof, "factory-underlying-coins");
    const underlyingDecimals = callByRole(proof, "factory-underlying-decimals");
    const isMeta = callByRole(proof, "factory-is-meta");
    const basePoolCallData = encodeFunctionData({
      abi: FACTORY_ABI,
      functionName: "get_base_pool",
      args: [policy.poolAddress],
    }).toLowerCase() as `0x${string}`;
    const underlyingCoinsCallData = encodeFunctionData({
      abi: FACTORY_ABI,
      functionName: "get_underlying_coins",
      args: [policy.poolAddress],
    }).toLowerCase() as `0x${string}`;
    const underlyingDecimalsCallData = encodeFunctionData({
      abi: FACTORY_ABI,
      functionName: "get_underlying_decimals",
      args: [policy.poolAddress],
    }).toLowerCase() as `0x${string}`;
    const isMetaCallData = encodeFunctionData({
      abi: FACTORY_ABI,
      functionName: "is_meta",
      args: [policy.poolAddress],
    }).toLowerCase() as `0x${string}`;
    try {
      const coins = underlyingCoins
        ? decodeFunctionResult({
            abi: FACTORY_ABI,
            functionName: "get_underlying_coins",
            data: underlyingCoins.returnData as `0x${string}`,
          }) as readonly string[]
        : [];
      const decimals = underlyingDecimals
        ? decodeFunctionResult({
            abi: FACTORY_ABI,
            functionName: "get_underlying_decimals",
            data: underlyingDecimals.returnData as `0x${string}`,
          }) as readonly bigint[]
        : [];
      if (
        !bindingCallMatches(basePool, policy.factoryAddress, basePoolCallData) ||
        !bindingCallMatches(
          underlyingCoins,
          policy.factoryAddress,
          underlyingCoinsCallData,
        ) ||
        !bindingCallMatches(
          underlyingDecimals,
          policy.factoryAddress,
          underlyingDecimalsCallData,
        ) ||
        !bindingCallMatches(isMeta, policy.factoryAddress, isMetaCallData) ||
        decodeAddress(FACTORY_ABI, "get_base_pool", basePool.returnData as `0x${string}`) !==
          policy.metapool.basePoolAddress ||
        decodeFunctionResult({
          abi: FACTORY_ABI,
          functionName: "is_meta",
          data: isMeta.returnData as `0x${string}`,
        }) !== true ||
        coins.length !== policy.executionTokens.length ||
        coins.some(
          (address, index) => canonicalAddress(address) !== policy.executionTokens[index]!.address,
        ) ||
        decimals.length !== policy.executionTokens.length ||
        decimals.some(
          (value, index) => Number(value) !== policy.executionTokens[index]!.decimals,
        )
      ) issues.add("metapool-path-proof-mismatch");
    } catch {
      issues.add("metapool-path-proof-mismatch");
    }
  }

  for (const point of profile.quoteProof) {
    try {
      const decoded = decodeFunctionData({
        abi: POOL_ABI,
        data: point.callData as `0x${string}`,
      });
      if (
        !indices.ok ||
        decoded.functionName !== policy.quoteFunction ||
        decoded.args[0] !== BigInt(indices.inputIndex) ||
        decoded.args[1] !== BigInt(indices.outputIndex) ||
        decoded.args[2].toString() !== point.amountInRaw ||
        decodeCurveCompositeQuote(policy, point.returnData as `0x${string}`)?.toString() !==
          point.amountOutRaw
      ) issues.add("quote-proof-mismatch");
    } catch {
      issues.add("quote-proof-mismatch");
    }
  }
  return [...issues];
}
