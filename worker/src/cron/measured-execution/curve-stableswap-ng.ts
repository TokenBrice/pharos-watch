import {
  decodeFunctionData,
  decodeFunctionResult,
  encodeFunctionData,
  keccak256,
  parseAbi,
} from "viem/utils";

import {
  DEX_CURVE_STABLESWAP_MEASURED_FRESHNESS_MAX_SEC,
  DEX_MEASURED_MAX_COST_BPS,
  buildDexMeasuredExecutionTargetId,
  type DexMeasuredExecutionProfile,
  type DexMeasuredExecutionStableSwapNgFactoryBindingProof,
  type DexMeasuredExecutionTarget,
} from "@shared/types/measured-execution";
import { throwIfAborted } from "../../lib/abort";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import {
  fetchEvmBlockHeader,
  fetchEvmCallHexAtBlock,
  fetchEvmCodeStatusAtBlock,
  fetchEvmMulticall3Aggregate3AtBlock,
  type EvmCodeAtBlockResult,
  type EvmBlockHeader,
  type EvmMulticall3Call,
  type EvmMulticall3Result,
} from "../../lib/evm-rpc";
import {
  DEX_MEASURED_EVM_REQUEST_TIMEOUT_MS,
  type DexMeasuredExecutionAdapter,
  type DexMeasuredExecutionBudgetStopReason,
  type DexMeasuredExecutionRpcBudget,
  type DexMeasuredRawQuotePoint,
} from "./profiles";

const CURVE_STABLESWAP_NG_POOL_ABI = parseAbi([
  "function coins(uint256) view returns (address)",
  "function get_dy(int128 i,int128 j,uint256 dx) view returns (uint256)",
]);
const CURVE_STABLESWAP_NG_FACTORY_ABI = parseAbi([
  "function pool_list(uint256) view returns (address)",
  "function get_coins(address pool) view returns (address[])",
]);
const ERC20_METADATA_ABI = parseAbi(["function decimals() view returns (uint8)"]);
const CURVE_STABLESWAP_NG_MULTICALL_BATCH_SIZE = 8;
const CURVE_STABLESWAP_NG_MULTICALL_GAS = "0x1c9c380";
const EVM_ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;

export const CURVE_STABLESWAP_NG_ADAPTER_PROFILE_ID =
  "curve-stableswap-ng-factory-get-dy-v2" as const;
export const CURVE_STABLESWAP_NG_MIN_COMPLETE_CYCLES = 3;
export const CURVE_STABLESWAP_NG_MIN_SUCCESSFUL_OBSERVATIONS = 3;

export interface CurveStableSwapNgPoolPolicy {
  chain: "ethereum";
  stablecoinId: "usdg-paxos";
  poolAddress: `0x${string}`;
  expectedPoolCodeHash: `0x${string}`;
  factoryAddress: `0x${string}`;
  expectedFactoryCodeHash: `0x${string}`;
  factoryPoolIndex: number;
  poolTokens: readonly [
    { address: `0x${string}`; symbol: "USDG"; decimals: 6; trackedAssetId: "usdg-paxos" },
    { address: `0x${string}`; symbol: "USDC"; decimals: 6; trackedAssetId: "usdc-circle" },
  ];
  inputIndex: 0;
  outputIndex: 1;
  mode: "active";
  scoreEligible: true;
}

/** Exact reviewed USDG/USDC StableSwap-NG deployment. This is not a generic Curve allowlist. */
export const CURVE_USDG_USDC_STABLESWAP_NG_POLICY: CurveStableSwapNgPoolPolicy = {
  chain: "ethereum",
  stablecoinId: "usdg-paxos",
  poolAddress: "0xc061caa073f3d95f80f8e5428d32d2d76f5e1622",
  expectedPoolCodeHash: "0x1c7b77a94bb42408ab6d5cfd76223f0c794db9b119bb6035db91d8b09da65512",
  factoryAddress: "0x6a8cbed756804b16e05e741edabd5cb544ae21bf",
  expectedFactoryCodeHash: "0xb78c1b32cd364260f3fa497ccc7e98c73cdc26bdae2d3635e763ee8b59a1d6fd",
  factoryPoolIndex: 563,
  poolTokens: [
    {
      address: "0xe343167631d89b6ffc58b88d6b7fb0228795491d",
      symbol: "USDG",
      decimals: 6,
      trackedAssetId: "usdg-paxos",
    },
    {
      address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      symbol: "USDC",
      decimals: 6,
      trackedAssetId: "usdc-circle",
    },
  ],
  inputIndex: 0,
  outputIndex: 1,
  mode: "active",
  scoreEligible: true,
};

export interface CurveStableSwapNgRuntimeEvidence {
  blockTimestamp: number;
  poolCodeHash: `0x${string}`;
  factoryBindingProof: DexMeasuredExecutionStableSwapNgFactoryBindingProof;
}

export type CurveStableSwapNgEligibilityFailure =
  | "pool-not-reviewed"
  | "execution-endpoint-mismatch"
  | "invalid-pinned-block"
  | "block-header-unavailable"
  | "block-header-mismatch"
  | "block-hash-invalid"
  | "block-commitment-mismatch"
  | "stale-pinned-block"
  | "future-pinned-block"
  | "runtime-code-unavailable"
  | "runtime-code-absent"
  | "runtime-code-hash-mismatch"
  | "factory-code-unavailable"
  | "factory-code-absent"
  | "factory-code-hash-mismatch"
  | "factory-membership-mismatch"
  | "factory-membership-unproven"
  | "pool-token-order-mismatch"
  | "pool-token-order-unproven"
  | "token-decimals-mismatch"
  | "token-decimals-unproven"
  | "rpc-failure";

export type CurveStableSwapNgEligibility =
  | { ok: true }
  | { ok: false; reason: CurveStableSwapNgEligibilityFailure };

function canonicalAddress(value: unknown): `0x${string}` | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return EVM_ADDRESS_PATTERN.test(normalized) ? (normalized as `0x${string}`) : null;
}

function canonicalHash(value: unknown): `0x${string}` | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return /^0x[0-9a-f]{64}$/.test(normalized) ? (normalized as `0x${string}`) : null;
}

export function getCurveStableSwapNgPolicy(
  chain: string,
  poolAddress: string,
): CurveStableSwapNgPoolPolicy | null {
  return chain.trim().toLowerCase() === CURVE_USDG_USDC_STABLESWAP_NG_POLICY.chain &&
    canonicalAddress(poolAddress) === CURVE_USDG_USDC_STABLESWAP_NG_POLICY.poolAddress
    ? CURVE_USDG_USDC_STABLESWAP_NG_POLICY
    : null;
}

export function evaluateCurveStableSwapNgEligibility(input: {
  chain: string;
  endpointAddress: string;
  blockNumber: number;
  nowSec: number;
  evidence?: CurveStableSwapNgRuntimeEvidence;
}): CurveStableSwapNgEligibility {
  const policy = getCurveStableSwapNgPolicy(input.chain, input.endpointAddress);
  if (!policy) return { ok: false, reason: "pool-not-reviewed" };
  if (canonicalAddress(input.endpointAddress) !== policy.poolAddress) {
    return { ok: false, reason: "execution-endpoint-mismatch" };
  }
  if (!Number.isSafeInteger(input.blockNumber) || input.blockNumber < 0) {
    return { ok: false, reason: "invalid-pinned-block" };
  }
  const evidence = input.evidence;
  if (!evidence || !Number.isSafeInteger(evidence.blockTimestamp) || evidence.blockTimestamp <= 0) {
    return { ok: false, reason: "block-header-unavailable" };
  }
  if (evidence.blockTimestamp > input.nowSec + 60) {
    return { ok: false, reason: "future-pinned-block" };
  }
  if (
    input.nowSec - evidence.blockTimestamp >
    DEX_CURVE_STABLESWAP_MEASURED_FRESHNESS_MAX_SEC
  ) {
    return { ok: false, reason: "stale-pinned-block" };
  }
  if (canonicalHash(evidence.poolCodeHash) == null) {
    return { ok: false, reason: "runtime-code-unavailable" };
  }
  if (evidence.poolCodeHash !== policy.expectedPoolCodeHash) {
    return { ok: false, reason: "runtime-code-hash-mismatch" };
  }
  const proof = evidence.factoryBindingProof;
  if (proof.blockNumber !== input.blockNumber) {
    return { ok: false, reason: "block-header-mismatch" };
  }
  if (!/^0x[0-9a-f]{64}$/.test(proof.blockHash)) {
    return { ok: false, reason: "block-hash-invalid" };
  }
  if (proof.blockCommitment !== "finalized") {
    return { ok: false, reason: "block-commitment-mismatch" };
  }
  if (canonicalHash(proof.factoryCodeHash) == null) {
    return { ok: false, reason: "factory-code-unavailable" };
  }
  if (proof.factoryCodeHash !== policy.expectedFactoryCodeHash) {
    return { ok: false, reason: "factory-code-hash-mismatch" };
  }
  if (
    proof.factoryAddress !== policy.factoryAddress ||
    proof.poolIndex !== policy.factoryPoolIndex ||
    proof.registeredPoolAddress !== policy.poolAddress
  ) {
    return { ok: false, reason: "factory-membership-mismatch" };
  }
  const expectedAddresses = policy.poolTokens.map((token) => token.address);
  if (
    proof.poolTokenAddresses.length !== expectedAddresses.length ||
    proof.poolTokenAddresses.some((address, index) => address !== expectedAddresses[index]) ||
    proof.poolCoinsProof.length !== policy.poolTokens.length ||
    proof.poolCoinsProof.some((entry, index) => entry.index !== index)
  ) {
    return { ok: false, reason: "pool-token-order-mismatch" };
  }
  if (
    proof.tokenDecimalsProof.length !== policy.poolTokens.length ||
    proof.tokenDecimalsProof.some((entry, index) =>
      entry.tokenAddress !== policy.poolTokens[index]!.address ||
      entry.decimals !== policy.poolTokens[index]!.decimals
    )
  ) {
    return { ok: false, reason: "token-decimals-mismatch" };
  }
  return { ok: true };
}

interface CurveStableSwapNgVerificationDependencies {
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

export type CurveStableSwapNgDeploymentVerification =
  | {
      ok: true;
      codeHash: `0x${string}`;
      blockNumber: number;
      blockTimestamp: number;
      runtimeEvidence: CurveStableSwapNgRuntimeEvidence;
      factoryBindingProof: DexMeasuredExecutionStableSwapNgFactoryBindingProof;
    }
  | { ok: false; reason: CurveStableSwapNgEligibilityFailure };

export function createCurveStableSwapNgDeploymentVerifier(
  dependencies: CurveStableSwapNgVerificationDependencies,
) {
  return async function verifyCurveStableSwapNgDeployment(input: {
    policy?: CurveStableSwapNgPoolPolicy;
    nowSec: number;
    chainRpcs: Map<string, ChainRpcConfig>;
    signal?: AbortSignal;
    rpcBudget?: DexMeasuredExecutionRpcBudget;
  }): Promise<CurveStableSwapNgDeploymentVerification> {
    const policy = input.policy ?? CURVE_USDG_USDC_STABLESWAP_NG_POLICY;
    const requestOptions = {
      chainRpcs: input.chainRpcs,
      signal: input.signal,
      timeoutMs: DEX_MEASURED_EVM_REQUEST_TIMEOUT_MS,
      maxRetries: 0,
      ...(input.rpcBudget ? { deadlineMs: input.rpcBudget.deadlineMs } : {}),
      ...(input.rpcBudget ? { beforeRequest: () => input.rpcBudget!.tryConsume() } : {}),
    };

    const blockHeader = await dependencies.fetchBlockHeader(
      policy.chain,
      "finalized",
      requestOptions,
    );
    input.rpcBudget?.recordChainResult(policy.chain, blockHeader != null);
    if (blockHeader == null) return { ok: false, reason: "block-header-unavailable" };
    if (!/^0x[0-9a-f]{64}$/.test(blockHeader.hash)) {
      return { ok: false, reason: "block-hash-invalid" };
    }
    const blockTimestamp = blockHeader.timestamp;
    if (blockTimestamp > input.nowSec + 60) return { ok: false, reason: "future-pinned-block" };
    if (
      input.nowSec - blockTimestamp >
      DEX_CURVE_STABLESWAP_MEASURED_FRESHNESS_MAX_SEC
    ) {
      return { ok: false, reason: "stale-pinned-block" };
    }

    const readCode = async (address: `0x${string}`): Promise<EvmCodeAtBlockResult> => {
      if (input.rpcBudget && !input.rpcBudget.canRequestChain(policy.chain)) {
        return { status: "unavailable" };
      }
      const result = await dependencies.fetchCodeStatus(
        policy.chain,
        address,
        blockHeader.number,
        requestOptions,
      );
      input.rpcBudget?.recordChainResult(policy.chain, result.status !== "unavailable");
      return result;
    };
    const readCall = async (
      address: `0x${string}`,
      callData: `0x${string}`,
    ): Promise<`0x${string}` | null> => {
      if (input.rpcBudget && !input.rpcBudget.canRequestChain(policy.chain)) return null;
      const result = await dependencies.fetchCall(
        policy.chain,
        address,
        callData,
        blockHeader.number,
        requestOptions,
      );
      input.rpcBudget?.recordChainResult(policy.chain, result != null);
      return result;
    };

    const poolCodeResult = await readCode(policy.poolAddress);
    if (poolCodeResult.status === "unavailable") {
      return { ok: false, reason: "runtime-code-unavailable" };
    }
    if (poolCodeResult.status === "absent") {
      return { ok: false, reason: "runtime-code-absent" };
    }
    const factoryCodeResult = await readCode(policy.factoryAddress);
    if (factoryCodeResult.status === "unavailable") {
      return { ok: false, reason: "factory-code-unavailable" };
    }
    if (factoryCodeResult.status === "absent") {
      return { ok: false, reason: "factory-code-absent" };
    }
    const hashCode = dependencies.hashCode ?? ((code: `0x${string}`) => keccak256(code));
    const poolCodeHash = hashCode(poolCodeResult.code).toLowerCase() as `0x${string}`;
    if (poolCodeHash !== policy.expectedPoolCodeHash) {
      return { ok: false, reason: "runtime-code-hash-mismatch" };
    }
    const factoryCodeHash = hashCode(factoryCodeResult.code).toLowerCase() as `0x${string}`;
    if (factoryCodeHash !== policy.expectedFactoryCodeHash) {
      return { ok: false, reason: "factory-code-hash-mismatch" };
    }

    const poolListCallData = encodeFunctionData({
      abi: CURVE_STABLESWAP_NG_FACTORY_ABI,
      functionName: "pool_list",
      args: [BigInt(policy.factoryPoolIndex)],
    }).toLowerCase() as `0x${string}`;
    const factoryCoinsCallData = encodeFunctionData({
      abi: CURVE_STABLESWAP_NG_FACTORY_ABI,
      functionName: "get_coins",
      args: [policy.poolAddress],
    }).toLowerCase() as `0x${string}`;
    const poolListReturnData = await readCall(policy.factoryAddress, poolListCallData);
    const factoryCoinsReturnData = await readCall(policy.factoryAddress, factoryCoinsCallData);
    if (poolListReturnData == null || factoryCoinsReturnData == null) {
      return { ok: false, reason: "factory-membership-unproven" };
    }

    let registeredPoolAddress: `0x${string}` | null;
    let factoryCoins: readonly (`0x${string}` | null)[];
    try {
      registeredPoolAddress = canonicalAddress(decodeFunctionResult({
        abi: CURVE_STABLESWAP_NG_FACTORY_ABI,
        functionName: "pool_list",
        data: poolListReturnData,
      }));
      factoryCoins = (decodeFunctionResult({
        abi: CURVE_STABLESWAP_NG_FACTORY_ABI,
        functionName: "get_coins",
        data: factoryCoinsReturnData,
      }) as readonly string[]).map((coin) => canonicalAddress(coin));
    } catch {
      return { ok: false, reason: "factory-membership-mismatch" };
    }
    const expectedAddresses = policy.poolTokens.map((token) => token.address);
    if (
      registeredPoolAddress !== policy.poolAddress ||
      factoryCoins.length !== expectedAddresses.length ||
      expectedAddresses.some((address, index) => factoryCoins[index] !== address)
    ) {
      return { ok: false, reason: "factory-membership-mismatch" };
    }

    const poolCoinsProof: DexMeasuredExecutionStableSwapNgFactoryBindingProof["poolCoinsProof"] = [];
    const tokenDecimalsProof:
      DexMeasuredExecutionStableSwapNgFactoryBindingProof["tokenDecimalsProof"] = [];
    for (let index = 0; index < policy.poolTokens.length; index += 1) {
      throwIfAborted(input.signal);
      const token = policy.poolTokens[index]!;
      const coinCallData = encodeFunctionData({
        abi: CURVE_STABLESWAP_NG_POOL_ABI,
        functionName: "coins",
        args: [BigInt(index)],
      }).toLowerCase() as `0x${string}`;
      const coinReturnData = await readCall(policy.poolAddress, coinCallData);
      if (coinReturnData == null) {
        return { ok: false, reason: "pool-token-order-unproven" };
      }
      let poolCoinAddress: `0x${string}` | null = null;
      try {
        poolCoinAddress = canonicalAddress(decodeFunctionResult({
          abi: CURVE_STABLESWAP_NG_POOL_ABI,
          functionName: "coins",
          data: coinReturnData,
        }));
      } catch {
        return { ok: false, reason: "pool-token-order-mismatch" };
      }
      if (poolCoinAddress !== token.address) return { ok: false, reason: "pool-token-order-mismatch" };
      poolCoinsProof.push({
        index,
        callData: coinCallData,
        returnData: coinReturnData.toLowerCase() as `0x${string}`,
      });

      const decimalsCallData = encodeFunctionData({
        abi: ERC20_METADATA_ABI,
        functionName: "decimals",
      }).toLowerCase() as `0x${string}`;
      const decimalsReturnData = await readCall(token.address, decimalsCallData);
      if (decimalsReturnData == null) {
        return { ok: false, reason: "token-decimals-unproven" };
      }
      let decimals: number;
      try {
        decimals = Number(decodeFunctionResult({
          abi: ERC20_METADATA_ABI,
          functionName: "decimals",
          data: decimalsReturnData,
        }));
      } catch {
        return { ok: false, reason: "token-decimals-mismatch" };
      }
      if (decimals !== token.decimals) return { ok: false, reason: "token-decimals-mismatch" };
      tokenDecimalsProof.push({
        tokenAddress: token.address,
        decimals,
        callData: decimalsCallData,
        returnData: decimalsReturnData.toLowerCase() as `0x${string}`,
      });
    }

    const revalidatedBlockHeader = await dependencies.fetchBlockHeader(
      policy.chain,
      blockHeader.number,
      requestOptions,
    );
    input.rpcBudget?.recordChainResult(policy.chain, revalidatedBlockHeader != null);
    if (revalidatedBlockHeader == null) {
      return { ok: false, reason: "block-header-unavailable" };
    }
    if (
      revalidatedBlockHeader.number !== blockHeader.number ||
      revalidatedBlockHeader.timestamp !== blockHeader.timestamp ||
      revalidatedBlockHeader.hash !== blockHeader.hash
    ) {
      return { ok: false, reason: "block-header-mismatch" };
    }

    const factoryBindingProof: DexMeasuredExecutionStableSwapNgFactoryBindingProof = {
      blockNumber: blockHeader.number,
      blockHash: blockHeader.hash,
      blockCommitment: "finalized",
      factoryAddress: policy.factoryAddress,
      factoryCodeHash,
      poolIndex: policy.factoryPoolIndex,
      registeredPoolAddress: policy.poolAddress,
      poolTokenAddresses: expectedAddresses,
      poolListCallData,
      poolListReturnData: poolListReturnData.toLowerCase() as `0x${string}`,
      factoryCoinsCallData,
      factoryCoinsReturnData: factoryCoinsReturnData.toLowerCase() as `0x${string}`,
      poolCoinsProof,
      tokenDecimalsProof,
    };
    const runtimeEvidence: CurveStableSwapNgRuntimeEvidence = {
      blockTimestamp,
      poolCodeHash,
      factoryBindingProof,
    };
    const eligibility = evaluateCurveStableSwapNgEligibility({
      chain: policy.chain,
      endpointAddress: policy.poolAddress,
      blockNumber: blockHeader.number,
      nowSec: input.nowSec,
      evidence: runtimeEvidence,
    });
    return eligibility.ok
      ? {
          ok: true,
          codeHash: poolCodeHash,
          blockNumber: blockHeader.number,
          blockTimestamp,
          runtimeEvidence,
          factoryBindingProof,
        }
      : eligibility;
  };
}

export const verifyCurveStableSwapNgDeployment = createCurveStableSwapNgDeploymentVerifier({
  fetchCodeStatus: fetchEvmCodeStatusAtBlock,
  fetchCall: fetchEvmCallHexAtBlock,
  fetchBlockHeader: fetchEvmBlockHeader,
});

export type CurveStableSwapNgQuoteFailure =
  | DexMeasuredExecutionBudgetStopReason
  | "unsupported-chain-or-pool"
  | "invalid-pinned-block"
  | "invalid-quote-input"
  | "invalid-curve-stableswap-ng-target"
  | "pool-token-order-mismatch"
  | "runtime-evidence-missing"
  | "rpc-failure"
  | "pool-revert"
  | "malformed-pool-return";

export interface CurveStableSwapNgRequest {
  target: DexMeasuredExecutionTarget;
  inputUsd: number;
  blockNumber: number;
  blockObservedAt: number;
  endpointAddress: `0x${string}`;
  runtimeEvidence?: CurveStableSwapNgRuntimeEvidence;
}

interface EncodedCurveStableSwapNgRequest extends CurveStableSwapNgRequest {
  index: number;
  label: string;
  amountInRaw: bigint;
  inputIndex: number;
  outputIndex: number;
  callData: `0x${string}`;
  policy: CurveStableSwapNgPoolPolicy;
  eligibility: CurveStableSwapNgEligibility;
}

export interface CurveStableSwapNgBatchOutcome {
  targetId: string;
  inputUsd: number;
  blockNumber: number;
  eligibility: CurveStableSwapNgEligibility;
  point?: DexMeasuredRawQuotePoint;
  failureReason?: CurveStableSwapNgQuoteFailure;
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
  const usdScaled = (amount * priceScaled * usdScale) / (10n ** BigInt(decimals) * priceScale);
  const usd = Number(usdScaled) / Number(usdScale);
  return Number.isFinite(usd) && usd >= 0 ? usd : null;
}

export function resolveCurveStableSwapNgTokenIndices(
  target: DexMeasuredExecutionTarget | DexMeasuredExecutionProfile,
): { ok: true; inputIndex: 0; outputIndex: 1 } | { ok: false; reason: CurveStableSwapNgQuoteFailure } {
  const endpointAddress =
    "executionEndpoint" in target
      ? target.executionEndpoint.address
      : target.poolId.slice(target.poolId.lastIndexOf(":") + 1);
  const policy = getCurveStableSwapNgPolicy(target.chain, endpointAddress);
  if (
    target.adapterProfileId !== CURVE_STABLESWAP_NG_ADAPTER_PROFILE_ID ||
    target.protocol.trim().toLowerCase() !== "curve" ||
    !policy ||
    target.poolTokenAddresses == null ||
    target.poolTokenAddresses.length !== policy.poolTokens.length ||
    target.poolTokenAddresses.some((address, index) => address !== policy.poolTokens[index]!.address) ||
    target.tokenIn.address !== policy.poolTokens[policy.inputIndex].address ||
    target.tokenOut.address !== policy.poolTokens[policy.outputIndex].address ||
    target.tokenIn.decimals !== policy.poolTokens[policy.inputIndex].decimals ||
    target.tokenOut.decimals !== policy.poolTokens[policy.outputIndex].decimals ||
    target.tokenIn.trackedAssetId !== policy.poolTokens[policy.inputIndex].trackedAssetId ||
    target.tokenOut.trackedAssetId !== policy.poolTokens[policy.outputIndex].trackedAssetId
  ) {
    return { ok: false, reason: "invalid-curve-stableswap-ng-target" };
  }
  return { ok: true, inputIndex: policy.inputIndex, outputIndex: policy.outputIndex };
}

export function encodeCurveStableSwapNgGetDy(input: {
  inputIndex: number;
  outputIndex: number;
  amountInRaw: bigint;
}): `0x${string}` {
  if (
    input.inputIndex !== CURVE_USDG_USDC_STABLESWAP_NG_POLICY.inputIndex ||
    input.outputIndex !== CURVE_USDG_USDC_STABLESWAP_NG_POLICY.outputIndex ||
    input.amountInRaw <= 0n
  ) throw new Error("Curve StableSwap-NG quote indices or amount are invalid");
  return encodeFunctionData({
    abi: CURVE_STABLESWAP_NG_POOL_ABI,
    functionName: "get_dy",
    args: [BigInt(input.inputIndex), BigInt(input.outputIndex), input.amountInRaw],
  }).toLowerCase() as `0x${string}`;
}

export function decodeCurveStableSwapNgGetDy(returnData: `0x${string}`): bigint | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(returnData)) return null;
  try {
    return decodeFunctionResult({
      abi: CURVE_STABLESWAP_NG_POOL_ABI,
      functionName: "get_dy",
      data: returnData,
    }) as bigint;
  } catch {
    return null;
  }
}

function prepareRequest(
  request: CurveStableSwapNgRequest,
  index: number,
): {
  encoded?: EncodedCurveStableSwapNgRequest;
  failureReason?: CurveStableSwapNgQuoteFailure;
  eligibility: CurveStableSwapNgEligibility;
} {
  const policy = getCurveStableSwapNgPolicy(request.target.chain, request.endpointAddress);
  const eligibility = evaluateCurveStableSwapNgEligibility({
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
  if (!eligibility.ok) {
    return {
      failureReason:
        eligibility.reason === "block-header-unavailable"
          ? "runtime-evidence-missing"
          : "invalid-curve-stableswap-ng-target",
      eligibility,
    };
  }
  const indices = resolveCurveStableSwapNgTokenIndices(request.target);
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
    return { failureReason: "invalid-curve-stableswap-ng-target", eligibility };
  }
  const amountInRaw = usdToRawAmount(
    request.inputUsd,
    request.target.tokenIn.decimals,
    request.target.tokenIn.referencePriceUsd,
  );
  if (amountInRaw == null) return { failureReason: "invalid-quote-input", eligibility };
  return {
    eligibility,
    encoded: {
      ...request,
      index,
      label: `${index}:${request.target.targetId}`,
      amountInRaw,
      inputIndex: indices.inputIndex,
      outputIndex: indices.outputIndex,
      callData: encodeCurveStableSwapNgGetDy({
        inputIndex: indices.inputIndex,
        outputIndex: indices.outputIndex,
        amountInRaw,
      }),
      policy,
      eligibility,
    },
  };
}

export function decodeCurveStableSwapNgQuotePoint(
  request: Pick<
    EncodedCurveStableSwapNgRequest,
    "amountInRaw" | "callData" | "inputIndex" | "outputIndex" | "blockNumber" | "endpointAddress" | "target"
  >,
  result: EvmMulticall3Result,
): { point?: DexMeasuredRawQuotePoint; failureReason?: CurveStableSwapNgQuoteFailure } {
  if (!result.success) return { failureReason: "pool-revert" };
  const amountOutRaw = decodeCurveStableSwapNgGetDy(result.returnData);
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
        factory: CURVE_USDG_USDC_STABLESWAP_NG_POLICY.factoryAddress,
        factoryPoolIndex: CURVE_USDG_USDC_STABLESWAP_NG_POLICY.factoryPoolIndex,
      },
    },
  };
}

interface CurveStableSwapNgQuoteDependencies {
  executeMulticall(input: {
    chain: string;
    calls: readonly EvmMulticall3Call[];
    blockNumber: number;
    chainRpcs: Map<string, ChainRpcConfig>;
    signal?: AbortSignal;
    rpcBudget?: DexMeasuredExecutionRpcBudget;
  }): Promise<EvmMulticall3Result[] | null>;
}

export function createCurveStableSwapNgQuoteExecutor(
  dependencies: CurveStableSwapNgQuoteDependencies,
) {
  return async function quoteCurveStableSwapNgRequests(input: {
    requests: readonly CurveStableSwapNgRequest[];
    chainRpcs: Map<string, ChainRpcConfig>;
    signal?: AbortSignal;
    rpcBudget?: DexMeasuredExecutionRpcBudget;
  }): Promise<CurveStableSwapNgBatchOutcome[]> {
    const prepared = input.requests.map(prepareRequest);
    const outcomes: CurveStableSwapNgBatchOutcome[] = input.requests.map((request, index) => ({
      targetId: request.target.targetId,
      inputUsd: request.inputUsd,
      blockNumber: request.blockNumber,
      eligibility: prepared[index]!.eligibility,
      ...(prepared[index]!.failureReason ? { failureReason: prepared[index]!.failureReason } : {}),
    }));
    const valid = prepared.flatMap((entry) => entry.encoded ? [entry.encoded] : []);
    for (let offset = 0; offset < valid.length; offset += CURVE_STABLESWAP_NG_MULTICALL_BATCH_SIZE) {
      throwIfAborted(input.signal);
      const chunk = valid.slice(offset, offset + CURVE_STABLESWAP_NG_MULTICALL_BATCH_SIZE);
      const chain = chunk[0]!.policy.chain;
      if (input.rpcBudget && !input.rpcBudget.canRequestChain(chain)) {
        for (const request of chunk) {
          outcomes[request.index] = {
            targetId: request.target.targetId,
            inputUsd: request.inputUsd,
            blockNumber: request.blockNumber,
            eligibility: request.eligibility,
            failureReason: input.rpcBudget.stopReason ?? "rpc-failure",
          };
        }
        continue;
      }
      const results = await dependencies.executeMulticall({
        chain,
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
      input.rpcBudget?.recordChainResult(chain, results != null);
      const byLabel = new Map((results ?? []).map((result) => [result.label, result]));
      for (const request of chunk) {
        const result = byLabel.get(request.label);
        outcomes[request.index] = {
          targetId: request.target.targetId,
          inputUsd: request.inputUsd,
          blockNumber: request.blockNumber,
          eligibility: request.eligibility,
          ...(result
            ? decodeCurveStableSwapNgQuotePoint(request, result)
            : { failureReason: input.rpcBudget?.stopReason ?? "rpc-failure" }),
        };
      }
    }
    return outcomes;
  };
}

export const quoteCurveStableSwapNgRequests = createCurveStableSwapNgQuoteExecutor({
  executeMulticall: async (input) =>
    fetchEvmMulticall3Aggregate3AtBlock(input.chain, input.calls, input.blockNumber, {
      chainRpcs: input.chainRpcs,
      signal: input.signal,
      timeoutMs: DEX_MEASURED_EVM_REQUEST_TIMEOUT_MS,
      maxRetries: 1,
      ...(input.rpcBudget ? { deadlineMs: input.rpcBudget.deadlineMs } : {}),
      ...(input.rpcBudget ? { beforeRequest: () => input.rpcBudget!.tryConsume() } : {}),
      gas: CURVE_STABLESWAP_NG_MULTICALL_GAS,
      multicallBatchSize: Math.min(
        CURVE_STABLESWAP_NG_MULTICALL_BATCH_SIZE,
        input.calls.length,
      ),
    }),
});

function decodeAddressResult(input: {
  abi: typeof CURVE_STABLESWAP_NG_FACTORY_ABI | typeof CURVE_STABLESWAP_NG_POOL_ABI;
  functionName: "pool_list" | "coins";
  returnData: string;
}): `0x${string}` | null {
  try {
    return canonicalAddress(decodeFunctionResult({
      abi: input.abi,
      functionName: input.functionName,
      data: input.returnData as `0x${string}`,
    } as never));
  } catch {
    return null;
  }
}

/** Exact ABI and reviewed StableSwap-NG factory-binding validation at the consumer boundary. */
export function validateCurveStableSwapNgProfileProof(
  profile: DexMeasuredExecutionProfile,
): string[] {
  const issues = new Set<string>();
  if (profile.adapterProfileId !== CURVE_STABLESWAP_NG_ADAPTER_PROFILE_ID) {
    issues.add("wrong-adapter-profile");
  }
  const policy = getCurveStableSwapNgPolicy(profile.chain, profile.executionEndpoint.address);
  if (!policy) issues.add("execution-pool-not-reviewed");
  if (profile.executionEndpoint.codeHash !== policy?.expectedPoolCodeHash) {
    issues.add("endpoint-code-hash-mismatch");
  }
  const indices = resolveCurveStableSwapNgTokenIndices(profile);
  if (!indices.ok) issues.add(indices.reason);

  const proof = profile.stableSwapNgFactoryBindingProof;
  if (!proof) {
    issues.add("factory-binding-proof-missing");
  } else if (policy) {
    if (
      proof.blockCommitment !== "finalized" ||
      proof.blockNumber !== profile.blockNumber
    ) issues.add("block-binding-mismatch");
    if (
      proof.factoryAddress !== policy.factoryAddress ||
      proof.factoryCodeHash !== policy.expectedFactoryCodeHash ||
      proof.poolIndex !== policy.factoryPoolIndex ||
      proof.registeredPoolAddress !== policy.poolAddress
    ) issues.add("factory-binding-mismatch");
    if (
      proof.poolTokenAddresses.length !== policy.poolTokens.length ||
      proof.poolTokenAddresses.some((address, index) => address !== policy.poolTokens[index]!.address)
    ) issues.add("pool-token-order-mismatch");

    try {
      const decodedCall = decodeFunctionData({
        abi: CURVE_STABLESWAP_NG_FACTORY_ABI,
        data: proof.poolListCallData as `0x${string}`,
      });
      if (
        decodedCall.functionName !== "pool_list" ||
        decodedCall.args[0] !== BigInt(policy.factoryPoolIndex) ||
        decodeAddressResult({
          abi: CURVE_STABLESWAP_NG_FACTORY_ABI,
          functionName: "pool_list",
          returnData: proof.poolListReturnData,
        }) !== policy.poolAddress
      ) issues.add("factory-pool-list-proof-mismatch");
    } catch {
      issues.add("factory-pool-list-proof-mismatch");
    }
    try {
      const decodedCall = decodeFunctionData({
        abi: CURVE_STABLESWAP_NG_FACTORY_ABI,
        data: proof.factoryCoinsCallData as `0x${string}`,
      });
      const decodedCoins = decodeFunctionResult({
        abi: CURVE_STABLESWAP_NG_FACTORY_ABI,
        functionName: "get_coins",
        data: proof.factoryCoinsReturnData as `0x${string}`,
      }) as readonly string[];
      if (
        decodedCall.functionName !== "get_coins" ||
        canonicalAddress(decodedCall.args[0]) !== policy.poolAddress ||
        decodedCoins.length !== policy.poolTokens.length ||
        policy.poolTokens.some((token, index) => canonicalAddress(decodedCoins[index]) !== token.address)
      ) issues.add("factory-coins-proof-mismatch");
    } catch {
      issues.add("factory-coins-proof-mismatch");
    }
    if (
      proof.poolCoinsProof.length !== policy.poolTokens.length ||
      proof.poolCoinsProof.some((entry, index) => {
        try {
          const call = decodeFunctionData({
            abi: CURVE_STABLESWAP_NG_POOL_ABI,
            data: entry.callData as `0x${string}`,
          });
          return (
            entry.index !== index ||
            call.functionName !== "coins" ||
            call.args[0] !== BigInt(index) ||
            decodeAddressResult({
              abi: CURVE_STABLESWAP_NG_POOL_ABI,
              functionName: "coins",
              returnData: entry.returnData,
            }) !== policy.poolTokens[index]!.address
          );
        } catch {
          return true;
        }
      })
    ) issues.add("pool-coins-proof-mismatch");
    if (
      proof.tokenDecimalsProof.length !== policy.poolTokens.length ||
      proof.tokenDecimalsProof.some((entry, index) => {
        try {
          const call = decodeFunctionData({
            abi: ERC20_METADATA_ABI,
            data: entry.callData as `0x${string}`,
          });
          const decimals = Number(decodeFunctionResult({
            abi: ERC20_METADATA_ABI,
            functionName: "decimals",
            data: entry.returnData as `0x${string}`,
          }));
          return (
            call.functionName !== "decimals" ||
            entry.tokenAddress !== policy.poolTokens[index]!.address ||
            entry.decimals !== policy.poolTokens[index]!.decimals ||
            decimals !== policy.poolTokens[index]!.decimals
          );
        } catch {
          return true;
        }
      })
    ) issues.add("token-decimals-proof-mismatch");
  }

  for (const point of profile.quoteProof) {
    if (point.reverted) {
      issues.add("quote-revert-not-publishable");
      continue;
    }
    try {
      const call = decodeFunctionData({
        abi: CURVE_STABLESWAP_NG_POOL_ABI,
        data: point.callData as `0x${string}`,
      });
      if (
        !indices.ok ||
        call.functionName !== "get_dy" ||
        call.args[0] !== BigInt(indices.inputIndex) ||
        call.args[1] !== BigInt(indices.outputIndex) ||
        call.args[2].toString() !== point.amountInRaw
      ) issues.add("call-data-mismatch");
      const amountOutRaw = decodeCurveStableSwapNgGetDy(point.returnData as `0x${string}`);
      if (amountOutRaw == null) issues.add("abi-decode-failed");
      else if (amountOutRaw.toString() !== point.amountOutRaw) issues.add("return-data-mismatch");
    } catch {
      issues.add("abi-decode-failed");
    }
  }
  return [...issues];
}

export const CURVE_STABLESWAP_NG_ADAPTER: DexMeasuredExecutionAdapter = {
  profileId: CURVE_STABLESWAP_NG_ADAPTER_PROFILE_ID,
  async quotePoints(input) {
    return {
      points: [],
      failures: input.inputNotionalsUsd.map((inputUsd) => ({
        inputUsd,
        reason: "runtime-evidence-missing",
      })),
    };
  },
};
