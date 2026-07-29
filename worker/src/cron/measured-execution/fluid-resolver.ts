import { decodeFunctionData, encodeFunctionData, keccak256, parseAbi } from "viem/utils";

import {
  DEX_MEASURED_MAX_COST_BPS,
  buildDexMeasuredExecutionTargetId,
  type DexMeasuredExecutionProfile,
  type DexMeasuredExecutionTarget,
} from "@shared/types/measured-execution";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { throwIfAborted } from "../../lib/abort";
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
import { executeAdaptiveMulticall } from "./adaptive-multicall";
import { forEachWithConcurrency } from "./concurrency";
import {
  MAX_UINT256,
  rawAmountToUsdOrNull as rawAmountToUsd,
  usdToRawAmount,
} from "./fixed-point";

const FLUID_RESOLVER_ABI = parseAbi([
  "function estimateSwapIn(address dex_,bool swap0To1_,uint256 amountIn_,uint256 minAmountOut_) view returns (uint256 amountOut_)",
]);
const FLUID_MULTICALL_BATCH_SIZE = 8;
const FLUID_MULTICALL_GAS = "0x1c9c380";
const EVM_ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;

export const FLUID_RESOLVER_ADAPTER_PROFILE_ID = "fluid-resolver-measured" as const;

export interface FluidResolverDeployment {
  adapterProfileId: typeof FLUID_RESOLVER_ADAPTER_PROFILE_ID;
  protocol: "fluid";
  chain: "ethereum" | "arbitrum" | "base" | "polygon";
  endpointAddress: `0x${string}`;
  expectedCodeHash: `0x${string}`;
  mode: "shadow";
  scoreEligible: false;
}

/**
 * Resolver deployments and runtime bytecode reviewed on 2026-07-15; all four
 * pinned hashes were re-verified against live runtime code on 2026-07-29.
 * Activation is cohort-scoped exactly like the QuoterV2 registry: Fluid stays
 * shadow-only and score-ineligible until the reviewed activation gates pass,
 * and registry presence alone never makes a lane score-eligible. The
 * 2026-07-29 evidence packet at
 * agents/safety-score-v9-producer-failed-remediation/artifacts/exact-dex-route-coverage/activation-fluid.json
 * records what already holds (no bytecode drift, live shadow observations on
 * Ethereum and Arbitrum, and an independent latest-block reproduction of a
 * published marginal output ratio) and the gaps that still block promotion:
 * this adapter carries no on-chain pool binding, so `poolId` and
 * `poolTokenAddresses` are trusted from the Fluid tickers API instead of being
 * proved through the Fluid DexFactory, and Base and Polygon have no published
 * shadow observation to review. Score eligibility additionally requires the
 * shared P4 capability matrix to admit this adapter profile.
 */
export const FLUID_RESOLVER_DEPLOYMENTS: readonly FluidResolverDeployment[] = [
  {
    adapterProfileId: FLUID_RESOLVER_ADAPTER_PROFILE_ID,
    protocol: "fluid",
    chain: "ethereum",
    endpointAddress: "0xc93876c0eed99645dd53937b25433e311881a27c",
    expectedCodeHash: "0x354034a96ded2ea80cab41cc6baac559a19a85f9f4054edd538b7e760c24a020",
    mode: "shadow",
    scoreEligible: false,
  },
  {
    adapterProfileId: FLUID_RESOLVER_ADAPTER_PROFILE_ID,
    protocol: "fluid",
    chain: "arbitrum",
    endpointAddress: "0x666a400b8cda0dc9b59d61706b0f982dddaf2d98",
    expectedCodeHash: "0xfb38d4fc733883b06b6aebddfda3452974d39d3ddd6fdc3eb71a99b68ba734e0",
    mode: "shadow",
    scoreEligible: false,
  },
  {
    adapterProfileId: FLUID_RESOLVER_ADAPTER_PROFILE_ID,
    protocol: "fluid",
    chain: "base",
    endpointAddress: "0x41e6055a282f8b7abdb8d22bcd85c2a0ee22e38a",
    expectedCodeHash: "0xcc12a6aad64b768dd7ca715688307a1be69f79ed044dc5b38c65698662bb580a",
    mode: "shadow",
    scoreEligible: false,
  },
  {
    adapterProfileId: FLUID_RESOLVER_ADAPTER_PROFILE_ID,
    protocol: "fluid",
    chain: "polygon",
    endpointAddress: "0x18dedd1cf3af3537d4e726d2aa81004d65da8581",
    expectedCodeHash: "0xb09436b50bf9bdf2290000aed803a979f58ef256868064efa0ab0e8aeec4b540",
    mode: "shadow",
    scoreEligible: false,
  },
] as const;

export type FluidResolverFailureReason =
  | DexMeasuredExecutionBudgetStopReason
  | "unsupported-chain"
  | "resolver-address-mismatch"
  | "resolver-code-unavailable"
  | "resolver-code-hash-mismatch"
  | "invalid-pinned-block"
  | "invalid-quote-input"
  | "invalid-fluid-target"
  | "missing-pool-token-order"
  | "invalid-pool-token-order"
  | "token-order-mismatch"
  | "resolver-revert"
  | "malformed-resolver-return";

export interface FluidResolverRequest {
  target: DexMeasuredExecutionTarget;
  inputUsd: number;
  blockNumber: number;
  endpointAddress: `0x${string}`;
}

interface EncodedFluidResolverRequest extends FluidResolverRequest {
  index: number;
  label: string;
  amountInRaw: bigint;
  swap0To1: boolean;
  callData: `0x${string}`;
  deployment: FluidResolverDeployment;
}

export interface FluidResolverBatchOutcome {
  targetId: string;
  inputUsd: number;
  blockNumber: number;
  point?: DexMeasuredRawQuotePoint;
  failureReason?: FluidResolverFailureReason;
}

interface FluidResolverQuoteDependencies {
  verifyDeployment(input: {
    deployment: FluidResolverDeployment;
    blockNumber: number;
    chainRpcs: Map<string, ChainRpcConfig>;
    signal?: AbortSignal;
    rpcBudget?: DexMeasuredExecutionRpcBudget;
  }): Promise<FluidResolverDeploymentVerification>;
  executeMulticall(input: {
    chain: string;
    calls: readonly EvmMulticall3Call[];
    blockNumber: number;
    chainRpcs: Map<string, ChainRpcConfig>;
    signal?: AbortSignal;
    rpcBudget?: DexMeasuredExecutionRpcBudget;
    onBudgetStop?: (reason: DexMeasuredExecutionBudgetStopReason) => void;
  }): Promise<EvmMulticall3Result[] | null>;
}

export type FluidResolverDeploymentVerification =
  | { ok: true; codeHash: `0x${string}` }
  | { ok: false; reason: "resolver-code-unavailable" | "resolver-code-hash-mismatch" };

function canonicalAddress(value: unknown): `0x${string}` | null {
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase();
  return EVM_ADDRESS_PATTERN.test(normalized) ? (normalized as `0x${string}`) : null;
}

export function resolveFluidPoolAddress(
  target: Pick<DexMeasuredExecutionTarget, "chain" | "poolId">,
): `0x${string}` | null {
  const unscoped = canonicalAddress(target.poolId);
  if (unscoped != null) return unscoped;
  const separatorIndex = target.poolId.indexOf(":");
  if (separatorIndex <= 0 || target.poolId.indexOf(":", separatorIndex + 1) !== -1) return null;
  const scopedChain = target.poolId.slice(0, separatorIndex).trim().toLowerCase();
  if (scopedChain !== target.chain.trim().toLowerCase()) return null;
  return canonicalAddress(target.poolId.slice(separatorIndex + 1));
}

export function getFluidResolverDeployment(chain: string): FluidResolverDeployment | null {
  const normalizedChain = chain.trim().toLowerCase();
  return FLUID_RESOLVER_DEPLOYMENTS.find((deployment) => deployment.chain === normalizedChain) ?? null;
}

export async function verifyFluidResolverDeployment(input: {
  deployment: FluidResolverDeployment;
  blockNumber: number;
  chainRpcs: Map<string, ChainRpcConfig>;
  signal?: AbortSignal;
  rpcBudget?: DexMeasuredExecutionRpcBudget;
}): Promise<FluidResolverDeploymentVerification> {
  if (input.rpcBudget && !input.rpcBudget.canRequestChain(input.deployment.chain)) {
    return { ok: false, reason: "resolver-code-unavailable" };
  }
  const code = await fetchEvmCodeAtBlock(input.deployment.chain, input.deployment.endpointAddress, input.blockNumber, {
    chainRpcs: input.chainRpcs,
    signal: input.signal,
    timeoutMs: DEX_MEASURED_EVM_REQUEST_TIMEOUT_MS,
    ...(input.rpcBudget ? { deadlineMs: input.rpcBudget.deadlineMs } : {}),
    ...(input.rpcBudget ? { beforeRequest: () => input.rpcBudget!.tryConsume() } : {}),
    maxRetries: 0,
  });
  input.rpcBudget?.recordChainResult(input.deployment.chain, code != null);
  if (code == null) return { ok: false, reason: "resolver-code-unavailable" };
  const codeHash = keccak256(code).toLowerCase() as `0x${string}`;
  if (codeHash !== input.deployment.expectedCodeHash) {
    return { ok: false, reason: "resolver-code-hash-mismatch" };
  }
  return { ok: true, codeHash };
}

export function resolveFluidSwapDirection(
  target: DexMeasuredExecutionTarget | DexMeasuredExecutionProfile,
): { ok: true; swap0To1: boolean } | { ok: false; reason: FluidResolverFailureReason } {
  if (target.adapterProfileId !== FLUID_RESOLVER_ADAPTER_PROFILE_ID || target.protocol.toLowerCase() !== "fluid") {
    return { ok: false, reason: "invalid-fluid-target" };
  }
  const poolAddress = resolveFluidPoolAddress(target);
  if (poolAddress == null) return { ok: false, reason: "invalid-fluid-target" };
  if (target.poolTokenAddresses == null) return { ok: false, reason: "missing-pool-token-order" };
  if (target.poolTokenAddresses.length !== 2) return { ok: false, reason: "invalid-pool-token-order" };

  const token0 = canonicalAddress(target.poolTokenAddresses[0]);
  const token1 = canonicalAddress(target.poolTokenAddresses[1]);
  if (token0 == null || token1 == null || token0 === token1) {
    return { ok: false, reason: "invalid-pool-token-order" };
  }
  const tokenIn = canonicalAddress(target.tokenIn.address);
  const tokenOut = canonicalAddress(target.tokenOut.address);
  if (tokenIn == null || tokenOut == null || tokenIn === tokenOut) {
    return { ok: false, reason: "invalid-fluid-target" };
  }
  if (tokenIn === token0 && tokenOut === token1) return { ok: true, swap0To1: true };
  if (tokenIn === token1 && tokenOut === token0) return { ok: true, swap0To1: false };
  return { ok: false, reason: "token-order-mismatch" };
}

export function encodeFluidEstimateSwapIn(input: {
  poolAddress: `0x${string}`;
  swap0To1: boolean;
  amountInRaw: bigint;
}): `0x${string}` {
  if (input.amountInRaw <= 0n) throw new Error("Fluid quote amount must be positive");
  const poolAddress = canonicalAddress(input.poolAddress);
  if (poolAddress == null) throw new Error("Fluid quote pool address is invalid");
  return encodeFunctionData({
    abi: FLUID_RESOLVER_ABI,
    functionName: "estimateSwapIn",
    args: [poolAddress, input.swap0To1, input.amountInRaw, 0n],
  }).toLowerCase() as `0x${string}`;
}

export function decodeFluidEstimateSwapIn(returnData: `0x${string}`): bigint | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(returnData)) return null;
  try {
    return BigInt(returnData);
  } catch {
    return null;
  }
}

function encodeRequest(
  request: FluidResolverRequest,
  index: number,
): { encoded?: EncodedFluidResolverRequest; failureReason?: FluidResolverFailureReason } {
  if (!Number.isSafeInteger(request.blockNumber) || request.blockNumber < 0) {
    return { failureReason: "invalid-pinned-block" };
  }
  const deployment = getFluidResolverDeployment(request.target.chain);
  if (deployment == null) return { failureReason: "unsupported-chain" };
  if (canonicalAddress(request.endpointAddress) !== deployment.endpointAddress) {
    return { failureReason: "resolver-address-mismatch" };
  }
  const direction = resolveFluidSwapDirection(request.target);
  if (!direction.ok) return { failureReason: direction.reason };
  const expectedTargetId = buildDexMeasuredExecutionTargetId({
    adapterProfileId: request.target.adapterProfileId,
    stablecoinId: request.target.stablecoinId,
    chain: request.target.chain,
    protocol: request.target.protocol,
    poolId: request.target.poolId,
    tokenInAddress: request.target.tokenIn.address,
    tokenOutAddress: request.target.tokenOut.address,
    ...(request.target.poolTokenAddresses ? { poolTokenAddresses: request.target.poolTokenAddresses } : {}),
    ...(request.target.feePips != null ? { feePips: request.target.feePips } : {}),
  });
  if (request.target.targetId !== expectedTargetId) return { failureReason: "invalid-fluid-target" };
  const amountInRaw = usdToRawAmount(
    request.inputUsd,
    request.target.tokenIn.decimals,
    request.target.tokenIn.referencePriceUsd,
    { maxRawAmount: MAX_UINT256 },
  );
  if (amountInRaw == null) return { failureReason: "invalid-quote-input" };
  const poolAddress = resolveFluidPoolAddress(request.target);
  if (poolAddress == null) return { failureReason: "invalid-fluid-target" };
  let callData: `0x${string}`;
  try {
    callData = encodeFluidEstimateSwapIn({
      poolAddress,
      swap0To1: direction.swap0To1,
      amountInRaw,
    });
  } catch {
    return { failureReason: "invalid-quote-input" };
  }
  return {
    encoded: {
      ...request,
      index,
      label: `${index}:${request.target.targetId}`,
      amountInRaw,
      swap0To1: direction.swap0To1,
      callData,
      deployment,
    },
  };
}

export function decodeFluidResolverQuotePoint(
  request: Pick<
    EncodedFluidResolverRequest,
    "amountInRaw" | "callData" | "swap0To1" | "blockNumber" | "deployment" | "target"
  >,
  result: EvmMulticall3Result,
): { point?: DexMeasuredRawQuotePoint; failureReason?: FluidResolverFailureReason } {
  if (!result.success) return { failureReason: "resolver-revert" };
  const amountOutRaw = decodeFluidEstimateSwapIn(result.returnData);
  if (amountOutRaw == null) return { failureReason: "malformed-resolver-return" };
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
    return { failureReason: "malformed-resolver-return" };
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
        resolver: request.deployment.endpointAddress,
        resolverCodeHash: request.deployment.expectedCodeHash,
        blockNumber: request.blockNumber,
        swap0To1: request.swap0To1,
        zeroLimitReturn: amountOutRaw === 0n,
      },
    },
  };
}

function createFluidResolverQuoteExecutor(dependencies: FluidResolverQuoteDependencies) {
  async function executeAdaptiveChunk(input: {
    chain: string;
    calls: readonly EvmMulticall3Call[];
    blockNumber: number;
    chainRpcs: Map<string, ChainRpcConfig>;
    signal?: AbortSignal;
    rpcBudget?: DexMeasuredExecutionRpcBudget;
  }) {
    return executeAdaptiveMulticall<EvmMulticall3Call, EvmMulticall3Result>({
      chain: input.chain,
      calls: input.calls,
      blockNumber: input.blockNumber,
      signal: input.signal,
      execute: ({ chain, calls, blockNumber, signal, onBudgetStop }) =>
        dependencies.executeMulticall({
          chain,
          calls,
          blockNumber,
          chainRpcs: input.chainRpcs,
          signal,
          rpcBudget: input.rpcBudget,
          onBudgetStop,
        }),
      failureResult: (call) => ({ label: call.label, success: false, returnData: "0x" }),
      getLabel: (call) => call.label,
      ...(input.rpcBudget ? { deadlineMs: input.rpcBudget.deadlineMs, budget: input.rpcBudget } : {}),
      failedAttemptAccounting: "single-call",
      unattemptedResult: "failure-result",
    });
  }

  return async function quoteFluidResolverRequests(input: {
    requests: readonly FluidResolverRequest[];
    chainRpcs: Map<string, ChainRpcConfig>;
    signal?: AbortSignal;
    rpcBudget?: DexMeasuredExecutionRpcBudget;
    deploymentVerified?: boolean;
  }): Promise<FluidResolverBatchOutcome[]> {
    const prepared = input.requests.map(encodeRequest);
    const outcomes: FluidResolverBatchOutcome[] = input.requests.map((request, index) => ({
      targetId: request.target.targetId,
      inputUsd: request.inputUsd,
      blockNumber: request.blockNumber,
      ...(prepared[index]?.failureReason ? { failureReason: prepared[index]!.failureReason } : {}),
    }));
    const valid = prepared.flatMap((entry) => (entry.encoded ? [entry.encoded] : []));
    const groupsByChain = new Map<string, EncodedFluidResolverRequest[]>();
    for (const request of valid) {
      const group = groupsByChain.get(request.deployment.chain) ?? [];
      group.push(request);
      groupsByChain.set(request.deployment.chain, group);
    }

    await forEachWithConcurrency([...groupsByChain.values()], 3, async (chainRequests) => {
      const requestsByBlock = new Map<number, EncodedFluidResolverRequest[]>();
      for (const request of chainRequests) {
        const blockRequests = requestsByBlock.get(request.blockNumber) ?? [];
        blockRequests.push(request);
        requestsByBlock.set(request.blockNumber, blockRequests);
      }

      // A chain lane owns one RPC request at a time, including when a caller
      // accidentally supplies more than one pinned block for the same chain.
      for (const requests of requestsByBlock.values()) {
        throwIfAborted(input.signal);
        const first = requests[0]!;
        const verification = input.deploymentVerified
          ? { ok: true as const, codeHash: first.deployment.expectedCodeHash }
          : await dependencies.verifyDeployment({
              deployment: first.deployment,
              blockNumber: first.blockNumber,
              chainRpcs: input.chainRpcs,
              signal: input.signal,
              rpcBudget: input.rpcBudget,
            });
        if (!verification.ok) {
          for (const request of requests) outcomes[request.index]!.failureReason = verification.reason;
          continue;
        }

        for (let offset = 0; offset < requests.length; offset += FLUID_MULTICALL_BATCH_SIZE) {
          throwIfAborted(input.signal);
          const chunk = requests.slice(offset, offset + FLUID_MULTICALL_BATCH_SIZE);
          const calls = chunk.map((request) => ({
            label: request.label,
            target: request.deployment.endpointAddress,
            callData: request.callData,
            allowFailure: true,
          }));
          const chunkResult = await executeAdaptiveChunk({
            chain: first.deployment.chain,
            calls,
            blockNumber: first.blockNumber,
            chainRpcs: input.chainRpcs,
            signal: input.signal,
            rpcBudget: input.rpcBudget,
          });
          const byLabel = new Map(chunkResult.results.map((result) => [result.label, result]));
          for (const request of chunk) {
            const result = byLabel.get(request.label);
            const budgetFailure = chunkResult.budgetStopReasonsByLabel.get(request.label);
            const decoded = budgetFailure
              ? { failureReason: budgetFailure }
              : result == null
                ? { failureReason: "resolver-revert" as const }
                : decodeFluidResolverQuotePoint(request, result);
            outcomes[request.index] = {
              targetId: request.target.targetId,
              inputUsd: request.inputUsd,
              blockNumber: request.blockNumber,
              ...decoded,
            };
          }
        }
      }
    });
    return outcomes;
  };
}

export const quoteFluidResolverRequests = createFluidResolverQuoteExecutor({
  verifyDeployment: verifyFluidResolverDeployment,
  executeMulticall: async (input) =>
    fetchEvmMulticall3Aggregate3AtBlock(input.chain, input.calls, input.blockNumber, {
      chainRpcs: input.chainRpcs,
      signal: input.signal,
      timeoutMs: DEX_MEASURED_EVM_REQUEST_TIMEOUT_MS,
      ...(input.rpcBudget ? { deadlineMs: input.rpcBudget.deadlineMs } : {}),
      ...(input.rpcBudget
        ? {
            beforeRequest: () => {
              const consumed = input.rpcBudget!.tryConsume();
              const reason = input.rpcBudget!.stopReason;
              if (!consumed && reason) input.onBudgetStop?.(reason);
              return consumed;
            },
          }
        : {}),
      maxRetries: 0,
      gas: FLUID_MULTICALL_GAS,
      multicallBatchSize: Math.min(FLUID_MULTICALL_BATCH_SIZE, input.calls.length),
    }),
});

/** ABI-bound proof validation specific to Fluid's reviewed resolver. */
export function validateFluidResolverProfileProof(profile: DexMeasuredExecutionProfile): string[] {
  const issues = new Set<string>();
  const deployment = getFluidResolverDeployment(profile.chain);
  if (profile.adapterProfileId !== FLUID_RESOLVER_ADAPTER_PROFILE_ID) issues.add("wrong-adapter-profile");
  if (deployment == null) {
    issues.add("unsupported-chain");
  } else if (
    canonicalAddress(profile.executionEndpoint.address) !== deployment.endpointAddress ||
    profile.executionEndpoint.codeHash.toLowerCase() !== deployment.expectedCodeHash
  ) {
    issues.add("resolver-identity-mismatch");
  }
  const direction = resolveFluidSwapDirection(profile);
  if (!direction.ok) issues.add(direction.reason);
  const poolAddress = resolveFluidPoolAddress(profile);

  for (const point of profile.quoteProof) {
    try {
      const decodedCall = decodeFunctionData({
        abi: FLUID_RESOLVER_ABI,
        data: point.callData as `0x${string}`,
      });
      if (decodedCall.functionName !== "estimateSwapIn") {
        issues.add("wrong-function-selector");
        continue;
      }
      const [quotedPool, swap0To1, amountInRaw, minAmountOut] = decodedCall.args;
      if (
        poolAddress == null ||
        canonicalAddress(quotedPool) !== poolAddress ||
        !direction.ok ||
        swap0To1 !== direction.swap0To1 ||
        amountInRaw.toString() !== point.amountInRaw ||
        minAmountOut !== 0n
      )
        issues.add("call-data-mismatch");

      const amountOutRaw = decodeFluidEstimateSwapIn(point.returnData as `0x${string}`);
      if (amountOutRaw == null) issues.add("abi-decode-failed");
      else if (amountOutRaw.toString() !== point.amountOutRaw) issues.add("return-data-mismatch");
    } catch {
      issues.add("abi-decode-failed");
    }
  }
  return [...issues];
}
