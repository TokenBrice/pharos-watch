import { decodeFunctionData, decodeFunctionResult, encodeFunctionData, keccak256, parseAbi } from "viem/utils";

import {
  DEX_CURVE_STABLESWAP_MEASURED_FRESHNESS_MAX_SEC, type DexMeasuredExecutionCurveCompositeProof,
  type DexMeasuredExecutionProfile, type DexMeasuredExecutionTarget,
} from "@shared/types/measured-execution";
import { throwIfAborted } from "../../lib/abort";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import {
  fetchEvmBlockHeader, fetchEvmCallHexAtBlock, fetchEvmCodeStatusAtBlock,
  type EvmBlockHeader, type EvmCodeAtBlockResult,
} from "../../lib/evm-rpc";
import {
  DEX_MEASURED_EVM_REQUEST_TIMEOUT_MS, type DexMeasuredExecutionRpcBudget,
} from "./profiles";
import { canonicalEvmAddress, decodeAddressResult as decodeEvmAddressResult } from "./evm-codecs";
import {
  CURVE_RATE_BEARING_ADAPTER_PROFILE_ID, getCurveCompositePolicy,
  type CurveCompositePoolPolicy,
} from "./curve-composite-policies";

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
const MAIN_REGISTRY_ARRAY_ABI = parseAbi([
  "function get_coins(address pool) view returns (address[8])",
  "function get_underlying_coins(address pool) view returns (address[8])",
  "function get_underlying_decimals(address pool) view returns (uint256[8])",
]);
const MAIN_REGISTRY_ABI = parseAbi([
  "function get_pool_from_lp_token(address lpToken) view returns (address)",
]);
const ERC20_ABI = parseAbi(["function decimals() view returns (uint8)"]);
const ERC4626_ABI = parseAbi([
  "function asset() view returns (address)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
]);
function decodeFactoryAddressArray(
  policy: CurveCompositePoolPolicy,
  functionName: "get_coins" | "get_underlying_coins",
  data: `0x${string}`,
  expectedLength: number,
): readonly string[] | null {
  try {
    const decoded = decodeFunctionResult({
      abi: policy.factoryArrayEncoding === "legacy-fixed"
        ? LEGACY_FACTORY_ARRAY_ABI
        : policy.factoryArrayEncoding === "registry-fixed"
          ? MAIN_REGISTRY_ARRAY_ABI
          : FACTORY_ABI,
      functionName,
      data,
    } as never) as readonly string[];
    if (policy.factoryArrayEncoding === "dynamic") return decoded;
    if (
      decoded.length < expectedLength ||
      decoded.slice(expectedLength).some(
        (address) => canonicalEvmAddress(address) !== "0x0000000000000000000000000000000000000000",
      )
    ) return null;
    return decoded.slice(0, expectedLength);
  } catch {
    return null;
  }
}

function decodeFactoryDecimalsArray(
  policy: CurveCompositePoolPolicy,
  data: `0x${string}`,
  expectedLength: number,
): readonly bigint[] | null {
  try {
    const decoded = decodeFunctionResult({
      abi: policy.factoryArrayEncoding === "legacy-fixed"
        ? LEGACY_FACTORY_ARRAY_ABI
        : policy.factoryArrayEncoding === "registry-fixed"
          ? MAIN_REGISTRY_ARRAY_ABI
          : FACTORY_ABI,
      functionName: "get_underlying_decimals",
      data,
    } as never) as readonly bigint[];
    if (policy.factoryArrayEncoding === "dynamic") return decoded;
    if (
      decoded.length < expectedLength ||
      decoded.slice(expectedLength).some((decimals) => decimals !== 0n)
    ) return null;
    return decoded.slice(0, expectedLength);
  } catch {
    return null;
  }
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
  if (canonicalEvmAddress(input.endpointAddress) !== policy.poolAddress) {
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
  abi:
    | typeof POOL_ABI
    | typeof FACTORY_ABI
    | typeof MAIN_REGISTRY_ABI
    | typeof ERC4626_ABI,
  functionName: string,
  data: `0x${string}`,
): `0x${string}` | null {
  return decodeEvmAddressResult({
    decode: () => decodeFunctionResult({ abi, functionName, data } as never),
  });
}

function createCurveCompositeDeploymentVerifier(dependencies: VerificationDependencies) {
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
    const implementationCode = policy.implementationBinding === "standalone-runtime"
      ? poolCode
      : await readCode(policy.implementationAddress);
    if (
      !implementationCode.ok ||
      implementationCode.hash !== policy.expectedImplementationCodeHash ||
      (
        policy.implementationBinding === "standalone-runtime" &&
        policy.implementationAddress !== policy.poolAddress
      )
    ) {
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
    const implementationResult = policy.implementationBinding === "factory-lookup"
      ? await readCall(
          "factory-implementation",
          policy.factoryAddress,
          encodeFunctionData({
            abi: FACTORY_ABI,
            functionName: "get_implementation_address",
            args: [policy.poolAddress],
          }).toLowerCase() as `0x${string}`,
        )
      : null;
    const [poolListResult, factoryCoinsResult] = [
      await readCall("factory-pool-list", policy.factoryAddress, poolListData),
      await readCall("factory-coins", policy.factoryAddress, factoryCoinsData),
    ];
    if (
      !poolListResult ||
      !factoryCoinsResult ||
      (policy.implementationBinding === "factory-lookup" && !implementationResult)
    ) {
      return { ok: false, reason: "rpc-failure" };
    }
    const factoryCoins = decodeFactoryAddressArray(
      policy,
      "get_coins",
      factoryCoinsResult,
      policy.poolTokens.length,
    );
    if (
      !factoryCoins ||
      decodeAddress(FACTORY_ABI, "pool_list", poolListResult) !== policy.poolAddress ||
      (
        policy.implementationBinding === "factory-lookup" &&
        decodeAddress(
          FACTORY_ABI,
          "get_implementation_address",
          implementationResult!,
        ) !== policy.implementationAddress
      ) ||
      factoryCoins.length !== policy.poolTokens.length ||
      factoryCoins.some(
        (address, index) => canonicalEvmAddress(address) !== policy.poolTokens[index]!.address,
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
      const basePoolData = policy.metapool.basePoolBinding === "registry-lp-token"
        ? encodeFunctionData({
            abi: MAIN_REGISTRY_ABI,
            functionName: "get_pool_from_lp_token",
            args: [policy.poolTokens[1].address],
          }).toLowerCase() as `0x${string}`
        : encodeFunctionData({
            abi: FACTORY_ABI,
            functionName: "get_base_pool",
            args: [policy.poolAddress],
          }).toLowerCase() as `0x${string}`;
      const basePoolRole = policy.metapool.basePoolBinding === "registry-lp-token"
        ? "registry-base-pool-from-lp-token"
        : "factory-base-pool";
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
        await readCall(basePoolRole, policy.factoryAddress, basePoolData),
        await readCall("factory-underlying-coins", policy.factoryAddress, underlyingCoinsData),
        await readCall("factory-underlying-decimals", policy.factoryAddress, underlyingDecimalsData),
        await readCall("factory-is-meta", policy.factoryAddress, isMetaData),
      ];
      if (!basePoolResult || !underlyingCoinsResult || !underlyingDecimalsResult || !isMetaResult) {
        return { ok: false, reason: "base-pool-mismatch" };
      }
      try {
        const underlyingCoins = decodeFactoryAddressArray(
          policy,
          "get_underlying_coins",
          underlyingCoinsResult,
          policy.executionTokens.length,
        );
        const underlyingDecimals = decodeFactoryDecimalsArray(
          policy,
          underlyingDecimalsResult,
          policy.executionTokens.length,
        );
        const isMeta = decodeFunctionResult({
          abi: FACTORY_ABI,
          functionName: "is_meta",
          data: isMetaResult,
        }) as boolean;
        const decodedBasePool = policy.metapool.basePoolBinding === "registry-lp-token"
          ? decodeAddress(MAIN_REGISTRY_ABI, "get_pool_from_lp_token", basePoolResult)
          : decodeAddress(FACTORY_ABI, "get_base_pool", basePoolResult);
        if (
          decodedBasePool !== policy.metapool.basePoolAddress ||
          !isMeta ||
          !underlyingCoins ||
          underlyingCoins.length !== policy.executionTokens.length ||
          underlyingCoins.some(
            (address, index) => canonicalEvmAddress(address) !== policy.executionTokens[index]!.address,
          ) ||
          !underlyingDecimals ||
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

export function resolveCurveCompositeTokenIndices(
  target: DexMeasuredExecutionTarget | DexMeasuredExecutionProfile,
):
  | { ok: true; inputIndex: number; outputIndex: number }
  | { ok: false; reason: "invalid-curve-composite-target" } {
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

export function decodeCurveCompositeQuote(
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
    ...(policy.implementationBinding === "factory-lookup" ? ["factory-implementation"] : []),
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
        policy.metapool.basePoolBinding === "registry-lp-token"
          ? "registry-base-pool-from-lp-token"
          : "factory-base-pool",
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
      ? decodeFactoryAddressArray(
          policy,
          "get_coins",
          factoryCoins.returnData as `0x${string}`,
          policy.poolTokens.length,
        )
      : null;
    if (
      !bindingCallMatches(factoryCoins, policy.factoryAddress, factoryCoinsCallData) ||
      !decoded ||
      decoded.length !== policy.poolTokens.length ||
      decoded.some(
        (address, index) => canonicalEvmAddress(address) !== policy.poolTokens[index]!.address,
      )
    ) issues.add("factory-coins-proof-mismatch");
  } catch {
    issues.add("factory-coins-proof-mismatch");
  }
  if (policy.implementationBinding === "factory-lookup") {
    if (
      !bindingCallMatches(implementation, policy.factoryAddress, implementationCallData) ||
      decodeAddress(
        FACTORY_ABI,
        "get_implementation_address",
        implementation.returnData as `0x${string}`,
      ) !== policy.implementationAddress
    ) issues.add("implementation-proof-mismatch");
  } else if (
    implementation != null ||
    policy.implementationAddress !== policy.poolAddress ||
    proof.implementationAddress !== policy.poolAddress ||
    proof.implementationCodeHash !== proof.poolCodeHash
  ) {
    issues.add("implementation-proof-mismatch");
  }

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
    const basePoolRole = policy.metapool.basePoolBinding === "registry-lp-token"
      ? "registry-base-pool-from-lp-token"
      : "factory-base-pool";
    const basePool = callByRole(proof, basePoolRole);
    const underlyingCoins = callByRole(proof, "factory-underlying-coins");
    const underlyingDecimals = callByRole(proof, "factory-underlying-decimals");
    const isMeta = callByRole(proof, "factory-is-meta");
    const basePoolCallData = policy.metapool.basePoolBinding === "registry-lp-token"
      ? encodeFunctionData({
          abi: MAIN_REGISTRY_ABI,
          functionName: "get_pool_from_lp_token",
          args: [policy.poolTokens[1].address],
        }).toLowerCase() as `0x${string}`
      : encodeFunctionData({
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
        ? decodeFactoryAddressArray(
            policy,
            "get_underlying_coins",
            underlyingCoins.returnData as `0x${string}`,
            policy.executionTokens.length,
          )
        : null;
      const decimals = underlyingDecimals
        ? decodeFactoryDecimalsArray(
            policy,
            underlyingDecimals.returnData as `0x${string}`,
            policy.executionTokens.length,
          )
        : null;
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
        (
          policy.metapool.basePoolBinding === "registry-lp-token"
            ? decodeAddress(
                MAIN_REGISTRY_ABI,
                "get_pool_from_lp_token",
                basePool.returnData as `0x${string}`,
              )
            : decodeAddress(
                FACTORY_ABI,
                "get_base_pool",
                basePool.returnData as `0x${string}`,
              )
        ) !== policy.metapool.basePoolAddress ||
        decodeFunctionResult({
          abi: FACTORY_ABI,
          functionName: "is_meta",
          data: isMeta.returnData as `0x${string}`,
        }) !== true ||
        !coins ||
        coins.length !== policy.executionTokens.length ||
        coins.some(
        (address, index) => canonicalEvmAddress(address) !== policy.executionTokens[index]!.address,
        ) ||
        !decimals ||
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
