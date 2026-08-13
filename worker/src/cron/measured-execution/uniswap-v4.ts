import {
  decodeFunctionData,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
  parseAbiParameters,
} from "viem/utils";

import {
  DEX_MEASURED_MAX_COST_BPS,
  type DexMeasuredExecutionProfile,
  type DexMeasuredExecutionTarget,
  type DexMeasuredExecutionUniswapV4PoolProof,
} from "@shared/types/measured-execution";
import { throwIfAborted } from "../../lib/abort";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import {
  fetchEvmCodeAtBlock,
  fetchEvmMulticall3Aggregate3AtBlock,
  type EvmMulticall3Call,
  type EvmMulticall3Result,
} from "../../lib/evm-rpc";
import {
  DEX_MEASURED_EVM_REQUEST_TIMEOUT_MS,
  type DexMeasuredExecutionBudgetStopReason,
  type DexMeasuredExecutionRpcBudget,
  type DexMeasuredRawQuotePoint,
} from "./profiles";
import { MAX_UINT128, rawAmountToUsd, usdToRawAmount } from "./fixed-point";

export const UNISWAP_V4_ADAPTER_PROFILE_ID = "uniswap-v4-hook-free-quoter-v1";
export const UNISWAP_V4_HOOK_FREE_ADDRESS =
  "0x0000000000000000000000000000000000000000" as const;

const UNISWAP_V4_QUOTER_ABI = parseAbi([
  "function poolManager() view returns (address)",
  "function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)",
]);
const UNISWAP_V4_STATE_VIEW_ABI = parseAbi([
  "function poolManager() view returns (address)",
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
]);
const UNISWAP_V4_POOL_KEY_PARAMETERS = parseAbiParameters(
  "address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks",
);
const UNISWAP_V4_MULTICALL_BATCH_SIZE = 8;
const UNISWAP_V4_MULTICALL_GAS = "0x1c9c380";
const UNISWAP_V4_Q192 = 1n << 192n;

export interface UniswapV4Deployment {
  adapterProfileId: typeof UNISWAP_V4_ADAPTER_PROFILE_ID;
  protocol: "uniswap-v4";
  chain: "ethereum";
  mode: "active" | "shadow";
  scoreEligible: boolean;
  poolManagerAddress: `0x${string}`;
  expectedPoolManagerCodeHash: `0x${string}`;
  stateViewAddress: `0x${string}`;
  expectedStateViewCodeHash: `0x${string}`;
  endpointAddress: `0x${string}`;
  expectedCodeHash: `0x${string}`;
}

/**
 * Official deployment identities:
 * https://developers.uniswap.org/docs/protocols/v4/deployments
 *
 * Runtime hashes were pinned from Ethereum block 25,618,353 on 2026-07-26.
 * The reviewed hook-free Ethereum cohort was activated after three productive
 * production shadow generations and a 129/130 successful latest generation on
 * 2026-08-13. Hooked pools and other deployments remain outside this registry.
 */
const UNISWAP_V4_DEPLOYMENTS: readonly UniswapV4Deployment[] = [
  {
    adapterProfileId: UNISWAP_V4_ADAPTER_PROFILE_ID,
    protocol: "uniswap-v4",
    chain: "ethereum",
    mode: "active",
    scoreEligible: true,
    poolManagerAddress: "0x000000000004444c5dc75cb358380d2e3de08a90",
    expectedPoolManagerCodeHash:
      "0x785f1014552b7ce7d5fb7d0c970ca60edee94fd00425d7ca21609acac7ce1293",
    stateViewAddress: "0x7ffe42c4a5deea5b0fec41c94c136cf115597227",
    expectedStateViewCodeHash:
      "0xd7947778589cf4aac9a092a4451292a2056380941635ab7006d3c691d8dfd878",
    endpointAddress: "0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203",
    expectedCodeHash:
      "0x06de58fa119c5deaa7a667fb92d3894e25d9160e62fb82c8d86d43b47eefe441",
  },
] as const;

export function getUniswapV4Deployment(
  chain: string,
): UniswapV4Deployment | null {
  const normalized = chain.trim().toLowerCase();
  return UNISWAP_V4_DEPLOYMENTS.find((deployment) => deployment.chain === normalized) ?? null;
}

export function computeUniswapV4PoolId(input: {
  currency0: `0x${string}`;
  currency1: `0x${string}`;
  feePips: number;
  tickSpacing: number;
  hookAddress: `0x${string}`;
}): `0x${string}` {
  return keccak256(
    encodeAbiParameters(UNISWAP_V4_POOL_KEY_PARAMETERS, [
      input.currency0,
      input.currency1,
      input.feePips,
      input.tickSpacing,
      input.hookAddress,
    ]),
  );
}

function targetPoolId(
  target: Pick<DexMeasuredExecutionTarget, "chain" | "poolId">,
): `0x${string}` | null {
  const normalized = target.poolId.trim().toLowerCase();
  const prefix = `${target.chain.trim().toLowerCase()}:`;
  const poolId = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
  return /^0x[a-f0-9]{64}$/.test(poolId) ? (poolId as `0x${string}`) : null;
}

function validateTargetPoolKey(
  target: Pick<
    DexMeasuredExecutionTarget,
    | "adapterProfileId"
    | "protocol"
    | "chain"
    | "poolId"
    | "poolTokenAddresses"
    | "tokenIn"
    | "tokenOut"
    | "feePips"
    | "tickSpacing"
    | "hookAddress"
  >,
): { poolId: `0x${string}`; zeroForOne: boolean } | null {
  if (
    target.adapterProfileId !== UNISWAP_V4_ADAPTER_PROFILE_ID ||
    target.protocol !== "uniswap-v4" ||
    target.poolTokenAddresses?.length !== 2 ||
    target.feePips == null ||
    target.tickSpacing == null ||
    target.hookAddress !== UNISWAP_V4_HOOK_FREE_ADDRESS ||
    target.feePips < 0 ||
    target.feePips > 1_000_000 ||
    target.tickSpacing <= 0 ||
    target.tickSpacing > 32_767
  ) {
    return null;
  }
  const [currency0, currency1] = target.poolTokenAddresses;
  if (
    currency0 >= currency1 ||
    (target.tokenIn.address !== currency0 && target.tokenIn.address !== currency1) ||
    (target.tokenOut.address !== currency0 && target.tokenOut.address !== currency1) ||
    target.tokenIn.address === target.tokenOut.address
  ) {
    return null;
  }
  const poolId = targetPoolId(target);
  if (
    poolId == null ||
    computeUniswapV4PoolId({
      currency0: currency0 as `0x${string}`,
      currency1: currency1 as `0x${string}`,
      feePips: target.feePips,
      tickSpacing: target.tickSpacing,
      hookAddress: UNISWAP_V4_HOOK_FREE_ADDRESS,
    }) !== poolId
  ) {
    return null;
  }
  return { poolId, zeroForOne: target.tokenIn.address === currency0 };
}

function decodeAddressResult(
  abi: typeof UNISWAP_V4_QUOTER_ABI | typeof UNISWAP_V4_STATE_VIEW_ABI,
  data: `0x${string}`,
): `0x${string}` | null {
  try {
    const result = decodeFunctionResult({
      abi,
      functionName: "poolManager",
      data,
    });
    const normalized = String(result).toLowerCase();
    return /^0x[a-f0-9]{40}$/.test(normalized) ? (normalized as `0x${string}`) : null;
  } catch {
    return null;
  }
}

export interface UniswapV4RuntimeEvidence {
  poolManagerCodeHash: `0x${string}`;
  stateViewCodeHash: `0x${string}`;
  quoterCodeHash: `0x${string}`;
  quoterPoolManagerCallData: `0x${string}`;
  quoterPoolManagerReturnData: `0x${string}`;
  stateViewPoolManagerCallData: `0x${string}`;
  stateViewPoolManagerReturnData: `0x${string}`;
}

export async function verifyUniswapV4Deployment(input: {
  deployment: UniswapV4Deployment;
  blockNumber: number;
  chainRpcs: Map<string, ChainRpcConfig>;
  signal?: AbortSignal;
  rpcBudget?: DexMeasuredExecutionRpcBudget;
}): Promise<
  | { ok: true; codeHash: `0x${string}`; runtimeEvidence: UniswapV4RuntimeEvidence }
  | {
      ok: false;
      reason:
        | "pool-manager-code-unavailable"
        | "pool-manager-code-hash-mismatch"
        | "state-view-code-unavailable"
        | "state-view-code-hash-mismatch"
        | "quoter-code-unavailable"
        | "quoter-code-hash-mismatch"
        | "runtime-binding-unavailable"
        | "runtime-binding-mismatch";
    }
> {
  const fetchCode = async (
    address: `0x${string}`,
  ): Promise<`0x${string}` | null> => {
    if (input.rpcBudget && !input.rpcBudget.canRequestChain(input.deployment.chain)) return null;
    const code = await fetchEvmCodeAtBlock(
      input.deployment.chain,
      address,
      input.blockNumber,
      {
        chainRpcs: input.chainRpcs,
        signal: input.signal,
        timeoutMs: DEX_MEASURED_EVM_REQUEST_TIMEOUT_MS,
        ...(input.rpcBudget ? { deadlineMs: input.rpcBudget.deadlineMs } : {}),
        ...(input.rpcBudget ? { beforeRequest: () => input.rpcBudget!.tryConsume() } : {}),
        maxRetries: 0,
      },
    );
    input.rpcBudget?.recordChainResult(input.deployment.chain, code != null);
    return code;
  };

  const poolManagerCode = await fetchCode(input.deployment.poolManagerAddress);
  if (poolManagerCode == null) return { ok: false, reason: "pool-manager-code-unavailable" };
  const poolManagerCodeHash = keccak256(poolManagerCode).toLowerCase() as `0x${string}`;
  if (poolManagerCodeHash !== input.deployment.expectedPoolManagerCodeHash) {
    return { ok: false, reason: "pool-manager-code-hash-mismatch" };
  }
  const stateViewCode = await fetchCode(input.deployment.stateViewAddress);
  if (stateViewCode == null) return { ok: false, reason: "state-view-code-unavailable" };
  const stateViewCodeHash = keccak256(stateViewCode).toLowerCase() as `0x${string}`;
  if (stateViewCodeHash !== input.deployment.expectedStateViewCodeHash) {
    return { ok: false, reason: "state-view-code-hash-mismatch" };
  }
  const quoterCode = await fetchCode(input.deployment.endpointAddress);
  if (quoterCode == null) return { ok: false, reason: "quoter-code-unavailable" };
  const quoterCodeHash = keccak256(quoterCode).toLowerCase() as `0x${string}`;
  if (quoterCodeHash !== input.deployment.expectedCodeHash) {
    return { ok: false, reason: "quoter-code-hash-mismatch" };
  }

  const quoterPoolManagerCallData = encodeFunctionData({
    abi: UNISWAP_V4_QUOTER_ABI,
    functionName: "poolManager",
  });
  const stateViewPoolManagerCallData = encodeFunctionData({
    abi: UNISWAP_V4_STATE_VIEW_ABI,
    functionName: "poolManager",
  });
  if (input.rpcBudget && !input.rpcBudget.canRequestChain(input.deployment.chain)) {
    return { ok: false, reason: "runtime-binding-unavailable" };
  }
  const bindingResults = await fetchEvmMulticall3Aggregate3AtBlock(
    input.deployment.chain,
    [
      {
        label: "quoter-pool-manager",
        target: input.deployment.endpointAddress,
        callData: quoterPoolManagerCallData,
        allowFailure: true,
      },
      {
        label: "state-view-pool-manager",
        target: input.deployment.stateViewAddress,
        callData: stateViewPoolManagerCallData,
        allowFailure: true,
      },
    ],
    input.blockNumber,
    {
      chainRpcs: input.chainRpcs,
      signal: input.signal,
      timeoutMs: DEX_MEASURED_EVM_REQUEST_TIMEOUT_MS,
      ...(input.rpcBudget ? { deadlineMs: input.rpcBudget.deadlineMs } : {}),
      ...(input.rpcBudget ? { beforeRequest: () => input.rpcBudget!.tryConsume() } : {}),
      maxRetries: 0,
      multicallBatchSize: 2,
    },
  );
  input.rpcBudget?.recordChainResult(input.deployment.chain, bindingResults != null);
  if (bindingResults == null) return { ok: false, reason: "runtime-binding-unavailable" };
  const byLabel = new Map(bindingResults.map((result) => [result.label, result]));
  const quoterBinding = byLabel.get("quoter-pool-manager");
  const stateViewBinding = byLabel.get("state-view-pool-manager");
  if (
    !quoterBinding?.success ||
    !stateViewBinding?.success ||
    decodeAddressResult(UNISWAP_V4_QUOTER_ABI, quoterBinding.returnData) !==
      input.deployment.poolManagerAddress ||
    decodeAddressResult(UNISWAP_V4_STATE_VIEW_ABI, stateViewBinding.returnData) !==
      input.deployment.poolManagerAddress
  ) {
    return { ok: false, reason: "runtime-binding-mismatch" };
  }
  return {
    ok: true,
    codeHash: quoterCodeHash,
    runtimeEvidence: {
      poolManagerCodeHash,
      stateViewCodeHash,
      quoterCodeHash,
      quoterPoolManagerCallData: quoterPoolManagerCallData.toLowerCase() as `0x${string}`,
      quoterPoolManagerReturnData: quoterBinding.returnData.toLowerCase() as `0x${string}`,
      stateViewPoolManagerCallData: stateViewPoolManagerCallData.toLowerCase() as `0x${string}`,
      stateViewPoolManagerReturnData: stateViewBinding.returnData.toLowerCase() as `0x${string}`,
    },
  };
}

/**
 * Upper bound on an exact-input quote implied by the proved pre-trade pool
 * price. A single-pool swap moves the marginal price monotonically against the
 * taker, so realized output can never beat the pre-trade spot price after the
 * LP fee, whatever the liquidity distribution across ticks. The bound stays
 * loose on the fee side (V4 takes any protocol fee first and rounds output
 * down), so a breach means the quote is not describing the proved pool state.
 */
export function computeUniswapV4SpotBoundAmountOut(input: {
  amountInRaw: bigint;
  sqrtPriceX96: bigint;
  lpFeePips: number;
  zeroForOne: boolean;
}): bigint | null {
  if (
    input.amountInRaw <= 0n ||
    input.sqrtPriceX96 <= 0n ||
    !Number.isInteger(input.lpFeePips) ||
    input.lpFeePips < 0 ||
    input.lpFeePips >= 1_000_000
  ) {
    return null;
  }
  const netAmountInRaw = (input.amountInRaw * BigInt(1_000_000 - input.lpFeePips)) / 1_000_000n;
  const priceX192 = input.sqrtPriceX96 * input.sqrtPriceX96;
  return input.zeroForOne
    ? (netAmountInRaw * priceX192) / UNISWAP_V4_Q192
    : (netAmountInRaw * UNISWAP_V4_Q192) / priceX192;
}

function encodeSlot0(poolId: `0x${string}`): `0x${string}` {
  return encodeFunctionData({
    abi: UNISWAP_V4_STATE_VIEW_ABI,
    functionName: "getSlot0",
    args: [poolId],
  });
}

function encodeLiquidity(poolId: `0x${string}`): `0x${string}` {
  return encodeFunctionData({
    abi: UNISWAP_V4_STATE_VIEW_ABI,
    functionName: "getLiquidity",
    args: [poolId],
  });
}

function decodeSlot0(
  returnData: `0x${string}`,
): { sqrtPriceX96: bigint; tick: number; protocolFee: number; lpFee: number } | null {
  try {
    const result = decodeFunctionResult({
      abi: UNISWAP_V4_STATE_VIEW_ABI,
      functionName: "getSlot0",
      data: returnData,
    });
    const [sqrtPriceX96, tick, protocolFee, lpFee] = result;
    return {
      sqrtPriceX96,
      tick,
      protocolFee,
      lpFee,
    };
  } catch {
    return null;
  }
}

function decodeLiquidity(returnData: `0x${string}`): bigint | null {
  try {
    return decodeFunctionResult({
      abi: UNISWAP_V4_STATE_VIEW_ABI,
      functionName: "getLiquidity",
      data: returnData,
    });
  } catch {
    return null;
  }
}

export interface UniswapV4PoolBindingOutcome {
  targetId: string;
  proof?: DexMeasuredExecutionUniswapV4PoolProof;
  failureReason?: string;
}

export async function resolveUniswapV4PoolBindings(input: {
  requests: ReadonlyArray<{
    target: DexMeasuredExecutionTarget;
    deployment: UniswapV4Deployment;
    runtimeEvidence: UniswapV4RuntimeEvidence;
  }>;
  blockNumber: number;
  chainRpcs: Map<string, ChainRpcConfig>;
  signal?: AbortSignal;
  rpcBudget?: DexMeasuredExecutionRpcBudget;
}): Promise<UniswapV4PoolBindingOutcome[]> {
  const encoded = input.requests.map((request, index) => {
    const poolKey = validateTargetPoolKey(request.target);
    if (poolKey == null) return null;
    return {
      ...request,
      index,
      poolId: poolKey.poolId,
      slot0CallData: encodeSlot0(poolKey.poolId),
      liquidityCallData: encodeLiquidity(poolKey.poolId),
    };
  });
  const outcomes = input.requests.map<UniswapV4PoolBindingOutcome>((request) => ({
    targetId: request.target.targetId,
  }));
  for (let index = 0; index < encoded.length; index++) {
    if (encoded[index] == null) {
      outcomes[index] = {
        targetId: input.requests[index]!.target.targetId,
        failureReason: "invalid-v4-target",
      };
    }
  }
  const valid = encoded.filter((request): request is NonNullable<typeof request> => request != null);
  for (let offset = 0; offset < valid.length; offset += UNISWAP_V4_MULTICALL_BATCH_SIZE) {
    throwIfAborted(input.signal);
    const chunk = valid.slice(offset, offset + UNISWAP_V4_MULTICALL_BATCH_SIZE);
    const chain = chunk[0]!.target.chain;
    if (input.rpcBudget && !input.rpcBudget.canRequestChain(chain)) {
      for (const request of chunk) {
        outcomes[request.index] = {
          targetId: request.target.targetId,
          failureReason: "pool-state-rpc-unavailable",
        };
      }
      continue;
    }
    const calls: EvmMulticall3Call[] = chunk.flatMap((request) => [
      {
        label: `${request.index}:slot0`,
        target: request.deployment.stateViewAddress,
        callData: request.slot0CallData,
        allowFailure: true,
      },
      {
        label: `${request.index}:liquidity`,
        target: request.deployment.stateViewAddress,
        callData: request.liquidityCallData,
        allowFailure: true,
      },
    ]);
    const results = await fetchEvmMulticall3Aggregate3AtBlock(
      chain,
      calls,
      input.blockNumber,
      {
        chainRpcs: input.chainRpcs,
        signal: input.signal,
        timeoutMs: DEX_MEASURED_EVM_REQUEST_TIMEOUT_MS,
        ...(input.rpcBudget ? { deadlineMs: input.rpcBudget.deadlineMs } : {}),
        ...(input.rpcBudget ? { beforeRequest: () => input.rpcBudget!.tryConsume() } : {}),
        maxRetries: 0,
        multicallBatchSize: calls.length,
      },
    );
    input.rpcBudget?.recordChainResult(chain, results != null);
    if (results == null) {
      for (const request of chunk) {
        outcomes[request.index] = {
          targetId: request.target.targetId,
          failureReason: input.rpcBudget?.stopReason ?? "pool-state-rpc-unavailable",
        };
      }
      continue;
    }
    const byLabel = new Map(results.map((result) => [result.label, result]));
    for (const request of chunk) {
      const slot0Result = byLabel.get(`${request.index}:slot0`);
      const liquidityResult = byLabel.get(`${request.index}:liquidity`);
      const slot0 = slot0Result?.success ? decodeSlot0(slot0Result.returnData) : null;
      const liquidity = liquidityResult?.success
        ? decodeLiquidity(liquidityResult.returnData)
        : null;
      if (!slot0Result?.success || !liquidityResult?.success || slot0 == null || liquidity == null) {
        outcomes[request.index] = {
          targetId: request.target.targetId,
          failureReason: "pool-state-call-failed",
        };
      } else if (slot0.sqrtPriceX96 <= 0n || liquidity <= 0n) {
        outcomes[request.index] = {
          targetId: request.target.targetId,
          failureReason: "pool-uninitialized-or-empty",
        };
      } else if (slot0.lpFee !== request.target.feePips) {
        outcomes[request.index] = {
          targetId: request.target.targetId,
          failureReason: "pool-fee-mismatch",
        };
      } else {
        outcomes[request.index] = {
          targetId: request.target.targetId,
          proof: {
            blockNumber: input.blockNumber,
            poolId: request.poolId,
            poolManagerAddress: request.deployment.poolManagerAddress,
            poolManagerCodeHash: request.runtimeEvidence.poolManagerCodeHash,
            stateViewAddress: request.deployment.stateViewAddress,
            stateViewCodeHash: request.runtimeEvidence.stateViewCodeHash,
            quoterPoolManagerCallData: request.runtimeEvidence.quoterPoolManagerCallData,
            quoterPoolManagerReturnData: request.runtimeEvidence.quoterPoolManagerReturnData,
            stateViewPoolManagerCallData: request.runtimeEvidence.stateViewPoolManagerCallData,
            stateViewPoolManagerReturnData: request.runtimeEvidence.stateViewPoolManagerReturnData,
            slot0CallData: request.slot0CallData.toLowerCase(),
            slot0ReturnData: slot0Result.returnData.toLowerCase(),
            liquidityCallData: request.liquidityCallData.toLowerCase(),
            liquidityReturnData: liquidityResult.returnData.toLowerCase(),
            sqrtPriceX96: slot0.sqrtPriceX96.toString(),
            tick: slot0.tick,
            protocolFee: slot0.protocolFee,
            lpFee: slot0.lpFee,
            liquidity: liquidity.toString(),
          },
        };
      }
    }
  }
  return outcomes;
}

interface UniswapV4QuoteRequest {
  target: DexMeasuredExecutionTarget;
  inputUsd: number;
  endpointAddress: `0x${string}`;
}

interface EncodedUniswapV4QuoteRequest extends UniswapV4QuoteRequest {
  index: number;
  label: string;
  amountInRaw: bigint;
  callData: `0x${string}`;
}

export interface UniswapV4QuoteOutcome {
  targetId: string;
  inputUsd: number;
  point?: DexMeasuredRawQuotePoint;
  failureReason?: string;
}

interface AdaptiveUniswapV4ChunkResult {
  results: EvmMulticall3Result[];
  transportFailureLabels: string[];
  budgetStopReasonsByLabel: Map<string, DexMeasuredExecutionBudgetStopReason>;
}

function encodeUniswapV4Quote(
  target: DexMeasuredExecutionTarget,
  amountInRaw: bigint,
): `0x${string}` {
  const poolKey = validateTargetPoolKey(target);
  if (poolKey == null) throw new Error(`Invalid Uniswap V4 target ${target.targetId}`);
  const [currency0, currency1] = target.poolTokenAddresses!;
  return encodeFunctionData({
    abi: UNISWAP_V4_QUOTER_ABI,
    functionName: "quoteExactInputSingle",
    args: [
      {
        poolKey: {
          currency0: currency0 as `0x${string}`,
          currency1: currency1 as `0x${string}`,
          fee: target.feePips!,
          tickSpacing: target.tickSpacing!,
          hooks: UNISWAP_V4_HOOK_FREE_ADDRESS,
        },
        zeroForOne: poolKey.zeroForOne,
        exactAmount: amountInRaw,
        hookData: "0x",
      },
    ],
  });
}

function encodeQuoteRequest(
  request: UniswapV4QuoteRequest,
  index: number,
): EncodedUniswapV4QuoteRequest | null {
  const amountInRaw = usdToRawAmount(
    request.inputUsd,
    request.target.tokenIn.decimals,
    request.target.tokenIn.referencePriceUsd,
    { maxRawAmount: MAX_UINT128 },
  );
  if (amountInRaw == null || validateTargetPoolKey(request.target) == null) return null;
  try {
    return {
      ...request,
      index,
      label: `${index}:${request.target.targetId}`,
      amountInRaw,
      callData: encodeUniswapV4Quote(request.target, amountInRaw),
    };
  } catch {
    return null;
  }
}

function decodeQuotePoint(
  request: EncodedUniswapV4QuoteRequest,
  result: EvmMulticall3Result,
): DexMeasuredRawQuotePoint | null {
  if (!result.success || result.returnData === "0x") return null;
  try {
    const [amountOutRaw, gasEstimate] = decodeFunctionResult({
      abi: UNISWAP_V4_QUOTER_ABI,
      functionName: "quoteExactInputSingle",
      data: result.returnData,
    });
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
    if (
      !Number.isFinite(inputUsd) ||
      inputUsd <= 0 ||
      !Number.isFinite(outputUsd) ||
      outputUsd < 0
    ) {
      return null;
    }
    const costBps = Math.max(0, (1 - outputUsd / inputUsd) * 10_000);
    return {
      amountInRaw: request.amountInRaw.toString(),
      amountOutRaw: amountOutRaw.toString(),
      callData: request.callData.toLowerCase(),
      returnData: result.returnData.toLowerCase() as `0x${string}`,
      inputUsd,
      outputUsd,
      costBps,
      passesCostBound: costBps <= DEX_MEASURED_MAX_COST_BPS,
      adapterMetadata: { gasEstimate: gasEstimate.toString() },
    };
  } catch {
    return null;
  }
}

function buildRevertedPoint(
  request: EncodedUniswapV4QuoteRequest,
  result: EvmMulticall3Result,
): DexMeasuredRawQuotePoint {
  return {
    amountInRaw: request.amountInRaw.toString(),
    amountOutRaw: "0",
    callData: request.callData.toLowerCase(),
    returnData: result.returnData.toLowerCase() as `0x${string}`,
    inputUsd: rawAmountToUsd(
      request.amountInRaw,
      request.target.tokenIn.decimals,
      request.target.tokenIn.referencePriceUsd,
    ),
    outputUsd: 0,
    costBps: 10_000,
    passesCostBound: false,
    reverted: true,
    adapterMetadata: { executionReverted: true },
  };
}

async function executeAdaptiveUniswapV4Chunk(input: {
  chain: string;
  calls: readonly EvmMulticall3Call[];
  blockNumber: number;
  chainRpcs: Map<string, ChainRpcConfig>;
  signal?: AbortSignal;
  rpcBudget?: DexMeasuredExecutionRpcBudget;
}): Promise<AdaptiveUniswapV4ChunkResult> {
  if (input.rpcBudget && !input.rpcBudget.canRequestChain(input.chain)) {
    return {
      results: input.calls.map((call) => ({
        label: call.label,
        success: false,
        returnData: "0x",
      })),
      transportFailureLabels: input.calls.map((call) => call.label),
      budgetStopReasonsByLabel: new Map(),
    };
  }

  let budgetStopReason: DexMeasuredExecutionBudgetStopReason | null = null;
  const results = await fetchEvmMulticall3Aggregate3AtBlock(
    input.chain,
    input.calls,
    input.blockNumber,
    {
      chainRpcs: input.chainRpcs,
      signal: input.signal,
      timeoutMs: DEX_MEASURED_EVM_REQUEST_TIMEOUT_MS,
      ...(input.rpcBudget ? { deadlineMs: input.rpcBudget.deadlineMs } : {}),
      ...(input.rpcBudget
        ? {
            beforeRequest: () => {
              const consumed = input.rpcBudget!.tryConsume();
              if (!consumed) budgetStopReason = input.rpcBudget!.stopReason;
              return consumed;
            },
          }
        : {}),
      maxRetries: 0,
      gas: UNISWAP_V4_MULTICALL_GAS,
      multicallBatchSize: input.calls.length,
    },
  );
  if (results != null) {
    input.rpcBudget?.recordChainResult(input.chain, true);
    return {
      results,
      transportFailureLabels: [],
      budgetStopReasonsByLabel: new Map(),
    };
  }
  if (
    budgetStopReason == null &&
    input.rpcBudget &&
    Date.now() >= input.rpcBudget.deadlineMs
  ) {
    budgetStopReason = "runtime-deadline-exceeded";
  }
  if (budgetStopReason != null) {
    return {
      results: input.calls.map((call) => ({
        label: call.label,
        success: false,
        returnData: "0x",
      })),
      transportFailureLabels: input.calls.map((call) => call.label),
      budgetStopReasonsByLabel: new Map(
        input.calls.map((call) => [call.label, budgetStopReason!]),
      ),
    };
  }
  if (input.calls.length === 1) {
    input.rpcBudget?.recordChainResult(input.chain, false);
    return {
      results: [{
        label: input.calls[0]!.label,
        success: false,
        returnData: "0x",
      }],
      transportFailureLabels: [input.calls[0]!.label],
      budgetStopReasonsByLabel: new Map(),
    };
  }

  const midpoint = Math.ceil(input.calls.length / 2);
  const left = await executeAdaptiveUniswapV4Chunk({
    ...input,
    calls: input.calls.slice(0, midpoint),
  });
  const right = await executeAdaptiveUniswapV4Chunk({
    ...input,
    calls: input.calls.slice(midpoint),
  });
  return {
    results: [...left.results, ...right.results],
    transportFailureLabels: [
      ...left.transportFailureLabels,
      ...right.transportFailureLabels,
    ],
    budgetStopReasonsByLabel: new Map([
      ...left.budgetStopReasonsByLabel,
      ...right.budgetStopReasonsByLabel,
    ]),
  };
}

export async function quoteUniswapV4Requests(input: {
  requests: readonly UniswapV4QuoteRequest[];
  blockNumber: number;
  chainRpcs: Map<string, ChainRpcConfig>;
  signal?: AbortSignal;
  rpcBudget?: DexMeasuredExecutionRpcBudget;
}): Promise<UniswapV4QuoteOutcome[]> {
  const encoded = input.requests.map(encodeQuoteRequest);
  const outcomes = input.requests.map<UniswapV4QuoteOutcome>((request, index) =>
    encoded[index] == null
      ? {
          targetId: request.target.targetId,
          inputUsd: request.inputUsd,
          failureReason: "invalid-quote-input",
        }
      : { targetId: request.target.targetId, inputUsd: request.inputUsd },
  );
  const valid = encoded.filter((request): request is EncodedUniswapV4QuoteRequest => request != null);
  const byChain = new Map<string, EncodedUniswapV4QuoteRequest[]>();
  for (const request of valid) {
    const rows = byChain.get(request.target.chain) ?? [];
    rows.push(request);
    byChain.set(request.target.chain, rows);
  }
  for (const [chain, requests] of byChain) {
    for (let offset = 0; offset < requests.length; offset += UNISWAP_V4_MULTICALL_BATCH_SIZE) {
      throwIfAborted(input.signal);
      const chunk = requests.slice(offset, offset + UNISWAP_V4_MULTICALL_BATCH_SIZE);
      const adaptive = await executeAdaptiveUniswapV4Chunk({
        chain,
        calls: chunk.map((request) => ({
          label: request.label,
          target: request.endpointAddress,
          callData: request.callData,
          allowFailure: true,
        })),
        blockNumber: input.blockNumber,
        chainRpcs: input.chainRpcs,
        signal: input.signal,
        rpcBudget: input.rpcBudget,
      });
      const byLabel = new Map(adaptive.results.map((result) => [result.label, result]));
      const transportFailureLabels = new Set(adaptive.transportFailureLabels);
      for (const request of chunk) {
        const result = byLabel.get(request.label);
        const budgetStopReason = adaptive.budgetStopReasonsByLabel.get(request.label);
        if (budgetStopReason) {
          outcomes[request.index] = {
            targetId: request.target.targetId,
            inputUsd: request.inputUsd,
            failureReason: budgetStopReason,
          };
        } else if (!result || transportFailureLabels.has(request.label)) {
          outcomes[request.index] = {
            targetId: request.target.targetId,
            inputUsd: request.inputUsd,
            failureReason: "quoter-rpc-unavailable",
          };
        } else if (!result.success) {
          outcomes[request.index] =
            result.returnData === "0x"
              ? {
                  targetId: request.target.targetId,
                  inputUsd: request.inputUsd,
                  failureReason: "quoter-empty-revert",
                }
              : {
                  targetId: request.target.targetId,
                  inputUsd: request.inputUsd,
                  point: buildRevertedPoint(request, result),
                };
        } else {
          const point = decodeQuotePoint(request, result);
          outcomes[request.index] = point
            ? {
                targetId: request.target.targetId,
                inputUsd: request.inputUsd,
                point,
              }
            : {
                targetId: request.target.targetId,
                inputUsd: request.inputUsd,
                failureReason: "quoter-invalid-result",
              };
        }
      }
    }
  }
  return outcomes;
}

function validatePoolManagerCall(
  abi: typeof UNISWAP_V4_QUOTER_ABI | typeof UNISWAP_V4_STATE_VIEW_ABI,
  callData: string,
  returnData: string,
  expectedPoolManager: string,
): boolean {
  try {
    const decoded = decodeFunctionData({ abi, data: callData as `0x${string}` });
    return (
      decoded.functionName === "poolManager" &&
      decodeAddressResult(abi, returnData as `0x${string}`) === expectedPoolManager
    );
  } catch {
    return false;
  }
}

/** Decode-bound validation for hook-free V4 runtime, PoolKey, state, and quotes. */
export function validateUniswapV4ProfileProof(
  profile: DexMeasuredExecutionProfile,
): string[] {
  const issues = new Set<string>();
  const deployment = getUniswapV4Deployment(profile.chain);
  const poolKey = validateTargetPoolKey(profile);
  if (!deployment) {
    issues.add("unsupported-deployment");
  } else if (
    profile.executionEndpoint.address !== deployment.endpointAddress ||
    profile.executionEndpoint.codeHash !== deployment.expectedCodeHash
  ) {
    issues.add("execution-endpoint-identity-mismatch");
  }
  if (poolKey == null) issues.add("invalid-v4-pool-key");
  const proof = profile.uniswapV4PoolProof;
  if (!deployment || !proof) {
    issues.add("v4-pool-proof-missing");
    return [...issues];
  }
  if (
    proof.blockNumber !== profile.blockNumber ||
    proof.poolId !== poolKey?.poolId ||
    proof.poolManagerAddress !== deployment.poolManagerAddress ||
    proof.poolManagerCodeHash !== deployment.expectedPoolManagerCodeHash ||
    proof.stateViewAddress !== deployment.stateViewAddress ||
    proof.stateViewCodeHash !== deployment.expectedStateViewCodeHash
  ) {
    issues.add("v4-runtime-or-pool-identity-mismatch");
  }
  if (
    !validatePoolManagerCall(
      UNISWAP_V4_QUOTER_ABI,
      proof.quoterPoolManagerCallData,
      proof.quoterPoolManagerReturnData,
      deployment.poolManagerAddress,
    ) ||
    !validatePoolManagerCall(
      UNISWAP_V4_STATE_VIEW_ABI,
      proof.stateViewPoolManagerCallData,
      proof.stateViewPoolManagerReturnData,
      deployment.poolManagerAddress,
    )
  ) {
    issues.add("v4-runtime-binding-mismatch");
  }
  try {
    const decodedSlotCall = decodeFunctionData({
      abi: UNISWAP_V4_STATE_VIEW_ABI,
      data: proof.slot0CallData as `0x${string}`,
    });
    const decodedLiquidityCall = decodeFunctionData({
      abi: UNISWAP_V4_STATE_VIEW_ABI,
      data: proof.liquidityCallData as `0x${string}`,
    });
    const decodedSlot = decodeSlot0(proof.slot0ReturnData as `0x${string}`);
    const decodedPoolLiquidity = decodeLiquidity(
      proof.liquidityReturnData as `0x${string}`,
    );
    if (
      decodedSlotCall.functionName !== "getSlot0" ||
      decodedLiquidityCall.functionName !== "getLiquidity" ||
      String(decodedSlotCall.args[0]).toLowerCase() !== proof.poolId ||
      String(decodedLiquidityCall.args[0]).toLowerCase() !== proof.poolId ||
      decodedSlot == null ||
      decodedPoolLiquidity == null ||
      decodedSlot.sqrtPriceX96.toString() !== proof.sqrtPriceX96 ||
      decodedSlot.tick !== proof.tick ||
      decodedSlot.protocolFee !== proof.protocolFee ||
      decodedSlot.lpFee !== proof.lpFee ||
      decodedPoolLiquidity.toString() !== proof.liquidity ||
      decodedSlot.sqrtPriceX96 <= 0n ||
      decodedPoolLiquidity <= 0n ||
      decodedSlot.lpFee !== profile.feePips
    ) {
      issues.add("v4-pool-state-proof-mismatch");
    }
  } catch {
    issues.add("v4-pool-state-proof-decode-failed");
  }

  const provedSqrtPriceX96 = /^[0-9]+$/.test(proof.sqrtPriceX96) ? BigInt(proof.sqrtPriceX96) : null;
  const sortedSuccessfulPoints = profile.quoteProof
    .filter((point) => !point.reverted)
    .sort((left, right) => left.inputUsd - right.inputUsd);
  for (let index = 0; index < profile.quoteProof.length; index++) {
    const point = profile.quoteProof[index]!;
    try {
      const decodedCall = decodeFunctionData({
        abi: UNISWAP_V4_QUOTER_ABI,
        data: point.callData as `0x${string}`,
      });
      if (decodedCall.functionName !== "quoteExactInputSingle") {
        issues.add("wrong-function-selector");
        continue;
      }
      const params = decodedCall.args[0];
      if (
        params.poolKey.currency0.toLowerCase() !== profile.poolTokenAddresses?.[0] ||
        params.poolKey.currency1.toLowerCase() !== profile.poolTokenAddresses?.[1] ||
        params.poolKey.fee !== profile.feePips ||
        params.poolKey.tickSpacing !== profile.tickSpacing ||
        params.poolKey.hooks.toLowerCase() !== UNISWAP_V4_HOOK_FREE_ADDRESS ||
        params.zeroForOne !== (profile.tokenIn.address === profile.poolTokenAddresses?.[0]) ||
        params.exactAmount.toString() !== point.amountInRaw ||
        params.hookData !== "0x"
      ) {
        issues.add("v4-call-data-mismatch");
      }
      if (point.reverted) {
        // Uniswap V4 quoter calls can surface quote-shaped payloads through a
        // reverted Multicall3 leg. The generic proof validator binds these as
        // zero-execution reverted points, so adapter validation only requires
        // the calldata identity above and retains the raw revert payload.
      } else {
        const [amountOut] = decodeFunctionResult({
          abi: UNISWAP_V4_QUOTER_ABI,
          functionName: "quoteExactInputSingle",
          data: point.returnData as `0x${string}`,
        });
        if (amountOut.toString() !== point.amountOutRaw) {
          issues.add("v4-return-data-mismatch");
        }
        const spotBoundAmountOut =
          provedSqrtPriceX96 == null
            ? null
            : computeUniswapV4SpotBoundAmountOut({
                amountInRaw: params.exactAmount,
                sqrtPriceX96: provedSqrtPriceX96,
                lpFeePips: proof.lpFee,
                zeroForOne: params.zeroForOne,
              });
        if (spotBoundAmountOut == null || amountOut > spotBoundAmountOut) {
          issues.add("v4-quote-exceeds-pool-spot-bound");
        }
      }
    } catch {
      issues.add("v4-abi-decode-failed");
    }
  }
  if (
    sortedSuccessfulPoints.some(
      (point, index) =>
        index > 0 &&
        point.costBps + 0.02 < sortedSuccessfulPoints[index - 1]!.costBps,
    )
  ) {
    issues.add("non-monotonic-quote-curve");
  }
  return [...issues];
}
