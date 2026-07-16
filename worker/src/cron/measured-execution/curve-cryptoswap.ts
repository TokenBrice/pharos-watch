import { decodeFunctionData, decodeFunctionResult, encodeFunctionData, parseAbi } from "viem/utils";

import {
  DEX_MEASURED_MAX_COST_BPS,
  buildDexMeasuredExecutionTargetId,
  type DexMeasuredExecutionProfile,
  type DexMeasuredExecutionTarget,
} from "@shared/types/measured-execution";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { throwIfAborted } from "../../lib/abort";
import {
  fetchEvmMulticall3Aggregate3AtBlock,
  type EvmMulticall3Call,
  type EvmMulticall3Result,
} from "../../lib/evm-rpc";
import type { DexMeasuredExecutionAdapter, DexMeasuredRawQuotePoint } from "./profiles";

const CURVE_CRYPTOSWAP_ABI = parseAbi(["function get_dy(uint256 i,uint256 j,uint256 dx) view returns (uint256)"]);
const CURVE_MULTICALL_BATCH_SIZE = 8;
const CURVE_MULTICALL_GAS = "0x1c9c380";
const EVM_ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const CODE_HASH_PATTERN = /^0x[0-9a-f]{64}$/;

export const CURVE_CRYPTOSWAP_ADAPTER_PROFILE_ID = "curve-cryptoswap-get-dy-v1" as const;

export type CurveCryptoSwapGeneration = "legacy-cryptoswap" | "twocrypto-ng" | "tricrypto-ng" | "special-tridbr";

export interface CurveCryptoSwapPoolPolicy {
  chain: "ethereum" | "arbitrum" | "base" | "polygon";
  poolAddress: `0x${string}`;
  generation: CurveCryptoSwapGeneration;
  mode: "shadow";
  scoreEligible: false;
  expectedPoolCodeHash?: `0x${string}`;
  expectedFactoryAddress?: `0x${string}`;
  expectedFactoryCodeHash?: `0x${string}`;
  expectedViewsAddress?: `0x${string}`;
  expectedViewsCodeHash?: `0x${string}`;
  expectedMathAddress?: `0x${string}`;
  expectedMathCodeHash?: `0x${string}`;
  transferSemanticsReviewed: false;
}

function shadowPolicy(
  chain: CurveCryptoSwapPoolPolicy["chain"],
  poolAddress: `0x${string}`,
  generation: CurveCryptoSwapGeneration,
): CurveCryptoSwapPoolPolicy {
  return {
    chain,
    poolAddress,
    generation,
    mode: "shadow",
    scoreEligible: false,
    transferSemanticsReviewed: false,
  };
}

/**
 * Fixed P7 retained cohort. Runtime and dependency hashes are intentionally
 * absent until the complete 25-pool census and transfer-semantics review land.
 */
export const CURVE_CRYPTOSWAP_SHADOW_COHORT: readonly CurveCryptoSwapPoolPolicy[] = [
  shadowPolicy("ethereum", "0xe79fb88c7937b39b3e1cabd44faefa5258578b2d", "twocrypto-ng"),
  shadowPolicy("ethereum", "0x384ca8992f955009bdd94849488e580559590157", "twocrypto-ng"),
  shadowPolicy("ethereum", "0x4fdccb810f22578ad6700fc10a8c9b6c1df61852", "twocrypto-ng"),
  shadowPolicy("ethereum", "0xca546ae6c3b2bb9fba2b6e5eeb0881097cece5b0", "twocrypto-ng"),
  shadowPolicy("ethereum", "0x592878b920101946fb5915ab97961bc546f211cc", "twocrypto-ng"),
  shadowPolicy("ethereum", "0x06ac09ca29369e2483533eb68dfe0a4d4143543d", "tricrypto-ng"),
  shadowPolicy("ethereum", "0x4ebdf703948ddcea3b11f675b4d1fba9d2414a14", "tricrypto-ng"),
  shadowPolicy("ethereum", "0xf1f435b05d255a5dbde37333c0f61da6f69c6127", "twocrypto-ng"),
  shadowPolicy("ethereum", "0x83f24023d15d835a213df24fd309c47dab5beb32", "twocrypto-ng"),
  shadowPolicy("ethereum", "0xd9ff8396554a0d18b2cfbec53e1979b7ecce8373", "twocrypto-ng"),
  shadowPolicy("ethereum", "0xec977f46467a3021785cff88894886e617abd65b", "twocrypto-ng"),
  shadowPolicy("ethereum", "0x66da369fc5dbba0774da70546bd20f2b242cd34d", "special-tridbr"),
  shadowPolicy("ethereum", "0x98a7f18d4e56cfe84e3d081b40001b3d5bd3eb8b", "legacy-cryptoswap"),
  shadowPolicy("ethereum", "0x26d85588b9ed20aba4fa8fb9b3c8977c4aad133c", "twocrypto-ng"),
  shadowPolicy("ethereum", "0x57129759d0e23116c1e7402dbc084e53d2e209a2", "twocrypto-ng"),
  shadowPolicy("ethereum", "0x43b98eea5c689f0036918f590a4b55f22d853734", "twocrypto-ng"),
  shadowPolicy("ethereum", "0x51a57b0a36ef63828929683609fa1fc12c72a776", "twocrypto-ng"),
  shadowPolicy("ethereum", "0x027b40f5917fcd0eac57d7015e120096a5f92ca9", "twocrypto-ng"),
  shadowPolicy("base", "0x6771bb9ec8da900eeba738599c3cc4f8fc07aea7d", "twocrypto-ng"),
  shadowPolicy("base", "0xba0c274085a078d19c46f2d902698a841cbfb289", "twocrypto-ng"),
  shadowPolicy("arbitrum", "0x590f7e2b211fa5ff7840dd3c425b543363797701", "twocrypto-ng"),
  shadowPolicy("polygon", "0xcb6dcbcb1da63acc01e6cc9804d0aee5a0dbb3ba", "twocrypto-ng"),
  shadowPolicy("polygon", "0xdcb72c163de84618417bec9aef7ae32b5336d70e", "twocrypto-ng"),
  shadowPolicy("polygon", "0xbae895c43c3af0f76e8bed2af8d1063afce35f5d", "twocrypto-ng"),
  shadowPolicy("polygon", "0xf5c83f5f7d3975726527feade0e51c6e5ecf7ba5", "twocrypto-ng"),
] as const;

export interface CurveCryptoSwapRuntimeEvidence {
  apiIsBroken?: boolean;
  poolCodeHash?: `0x${string}`;
  factoryAddress?: `0x${string}`;
  factoryCodeHash?: `0x${string}`;
  viewsAddress?: `0x${string}`;
  viewsCodeHash?: `0x${string}`;
  mathAddress?: `0x${string}`;
  mathCodeHash?: `0x${string}`;
  legacyIsKilled?: boolean;
  ngKillMethodUnavailable?: boolean;
  transferSemanticsReviewed?: boolean;
}

export type CurveCryptoSwapEligibilityFailure =
  | "pool-not-in-shadow-cohort"
  | "execution-endpoint-mismatch"
  | "api-broken-or-unknown"
  | "legacy-kill-state-unavailable"
  | "legacy-pool-killed"
  | "ng-kill-method-not-proven-absent"
  | "runtime-allowlist-incomplete"
  | "runtime-code-unavailable"
  | "runtime-code-hash-mismatch"
  | "dependency-code-unavailable"
  | "dependency-identity-mismatch"
  | "dependency-code-hash-mismatch"
  | "transfer-semantics-unreviewed"
  | "shadow-score-ineligible";

export type CurveCryptoSwapEligibility = { ok: true } | { ok: false; reason: CurveCryptoSwapEligibilityFailure };

export function getCurveCryptoSwapShadowPolicy(chain: string, poolAddress: string): CurveCryptoSwapPoolPolicy | null {
  const address = canonicalAddress(poolAddress);
  const normalizedChain = chain.trim().toLowerCase();
  if (address == null) return null;
  return (
    CURVE_CRYPTOSWAP_SHADOW_COHORT.find((entry) => entry.chain === normalizedChain && entry.poolAddress === address) ??
    null
  );
}

function matchesAddress(actual: unknown, expected: `0x${string}`): boolean {
  return canonicalAddress(actual) === expected;
}

function matchesCodeHash(actual: unknown, expected: `0x${string}`): boolean {
  return canonicalCodeHash(actual) === expected;
}

/** Fail-closed score eligibility independent of quote transport. */
export function evaluateCurveCryptoSwapEligibility(input: {
  chain: string;
  endpointAddress: string;
  policy?: CurveCryptoSwapPoolPolicy | null;
  evidence?: CurveCryptoSwapRuntimeEvidence;
}): CurveCryptoSwapEligibility {
  const endpointAddress = canonicalAddress(input.endpointAddress);
  const policy = input.policy ?? getCurveCryptoSwapShadowPolicy(input.chain, input.endpointAddress);
  if (policy == null) return { ok: false, reason: "pool-not-in-shadow-cohort" };
  if (endpointAddress !== policy.poolAddress || input.chain.trim().toLowerCase() !== policy.chain) {
    return { ok: false, reason: "execution-endpoint-mismatch" };
  }
  const evidence = input.evidence;
  if (evidence?.apiIsBroken !== false) return { ok: false, reason: "api-broken-or-unknown" };

  if (policy.generation === "legacy-cryptoswap") {
    if (evidence.legacyIsKilled == null) return { ok: false, reason: "legacy-kill-state-unavailable" };
    if (evidence.legacyIsKilled) return { ok: false, reason: "legacy-pool-killed" };
  } else if (evidence.ngKillMethodUnavailable !== true) {
    return { ok: false, reason: "ng-kill-method-not-proven-absent" };
  }

  const expectedHashes = [
    policy.expectedPoolCodeHash,
    policy.expectedFactoryCodeHash,
    policy.expectedViewsCodeHash,
    policy.expectedMathCodeHash,
  ];
  const expectedAddresses = [policy.expectedFactoryAddress, policy.expectedViewsAddress, policy.expectedMathAddress];
  if (expectedHashes.some((value) => value == null) || expectedAddresses.some((value) => value == null)) {
    return { ok: false, reason: "runtime-allowlist-incomplete" };
  }
  if (canonicalCodeHash(evidence.poolCodeHash) == null) return { ok: false, reason: "runtime-code-unavailable" };
  if (!matchesCodeHash(evidence.poolCodeHash, policy.expectedPoolCodeHash!)) {
    return { ok: false, reason: "runtime-code-hash-mismatch" };
  }
  if (
    canonicalAddress(evidence.factoryAddress) == null ||
    canonicalCodeHash(evidence.factoryCodeHash) == null ||
    canonicalAddress(evidence.viewsAddress) == null ||
    canonicalCodeHash(evidence.viewsCodeHash) == null ||
    canonicalAddress(evidence.mathAddress) == null ||
    canonicalCodeHash(evidence.mathCodeHash) == null
  )
    return { ok: false, reason: "dependency-code-unavailable" };
  if (
    !matchesAddress(evidence.factoryAddress, policy.expectedFactoryAddress!) ||
    !matchesAddress(evidence.viewsAddress, policy.expectedViewsAddress!) ||
    !matchesAddress(evidence.mathAddress, policy.expectedMathAddress!)
  )
    return { ok: false, reason: "dependency-identity-mismatch" };
  if (
    !matchesCodeHash(evidence.factoryCodeHash, policy.expectedFactoryCodeHash!) ||
    !matchesCodeHash(evidence.viewsCodeHash, policy.expectedViewsCodeHash!) ||
    !matchesCodeHash(evidence.mathCodeHash, policy.expectedMathCodeHash!)
  )
    return { ok: false, reason: "dependency-code-hash-mismatch" };
  if (!policy.transferSemanticsReviewed || evidence.transferSemanticsReviewed !== true) {
    return { ok: false, reason: "transfer-semantics-unreviewed" };
  }
  if (!policy.scoreEligible) return { ok: false, reason: "shadow-score-ineligible" };
  return { ok: true };
}

export type CurveCryptoSwapQuoteFailure =
  | "unsupported-chain-or-pool"
  | "invalid-pinned-block"
  | "invalid-quote-input"
  | "invalid-curve-cryptoswap-target"
  | "missing-pool-token-order"
  | "invalid-pool-token-order"
  | "ambiguous-token-index"
  | "token-index-mismatch"
  | "pool-revert"
  | "malformed-pool-return";

export interface CurveCryptoSwapRequest {
  target: DexMeasuredExecutionTarget;
  inputUsd: number;
  blockNumber: number;
  endpointAddress: `0x${string}`;
  runtimeEvidence?: CurveCryptoSwapRuntimeEvidence;
}

interface EncodedCurveCryptoSwapRequest extends CurveCryptoSwapRequest {
  index: number;
  label: string;
  amountInRaw: bigint;
  inputIndex: number;
  outputIndex: number;
  callData: `0x${string}`;
  endpointAddress: `0x${string}`;
  policy: CurveCryptoSwapPoolPolicy;
  eligibility: CurveCryptoSwapEligibility;
}

export interface CurveCryptoSwapBatchOutcome {
  targetId: string;
  inputUsd: number;
  blockNumber: number;
  eligibility: CurveCryptoSwapEligibility;
  point?: DexMeasuredRawQuotePoint;
  failureReason?: CurveCryptoSwapQuoteFailure;
}

interface CurveCryptoSwapQuoteDependencies {
  executeMulticall(input: {
    chain: string;
    calls: readonly EvmMulticall3Call[];
    blockNumber: number;
    chainRpcs: Map<string, ChainRpcConfig>;
    signal?: AbortSignal;
  }): Promise<EvmMulticall3Result[] | null>;
}

function canonicalAddress(value: unknown): `0x${string}` | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return EVM_ADDRESS_PATTERN.test(normalized) ? (normalized as `0x${string}`) : null;
}

function canonicalCodeHash(value: unknown): `0x${string}` | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return CODE_HASH_PATTERN.test(normalized) ? (normalized as `0x${string}`) : null;
}

export function resolveCurveCryptoSwapTokenIndices(
  target: DexMeasuredExecutionTarget | DexMeasuredExecutionProfile,
): { ok: true; inputIndex: number; outputIndex: number } | { ok: false; reason: CurveCryptoSwapQuoteFailure } {
  if (
    target.adapterProfileId !== CURVE_CRYPTOSWAP_ADAPTER_PROFILE_ID ||
    target.protocol.trim().toLowerCase() !== "curve"
  )
    return { ok: false, reason: "invalid-curve-cryptoswap-target" };
  if (target.poolTokenAddresses == null) return { ok: false, reason: "missing-pool-token-order" };
  if (target.poolTokenAddresses.length < 2 || target.poolTokenAddresses.length > 8) {
    return { ok: false, reason: "invalid-pool-token-order" };
  }
  const orderedTokens = target.poolTokenAddresses.map(canonicalAddress);
  if (orderedTokens.some((address) => address == null)) {
    return { ok: false, reason: "invalid-pool-token-order" };
  }
  const tokenIn = canonicalAddress(target.tokenIn.address);
  const tokenOut = canonicalAddress(target.tokenOut.address);
  if (tokenIn == null || tokenOut == null || tokenIn === tokenOut) {
    return { ok: false, reason: "invalid-curve-cryptoswap-target" };
  }
  const inputMatches = orderedTokens.flatMap((address, index) => (address === tokenIn ? [index] : []));
  const outputMatches = orderedTokens.flatMap((address, index) => (address === tokenOut ? [index] : []));
  if (inputMatches.length > 1 || outputMatches.length > 1) {
    return { ok: false, reason: "ambiguous-token-index" };
  }
  if (inputMatches.length !== 1 || outputMatches.length !== 1 || inputMatches[0] === outputMatches[0]) {
    return { ok: false, reason: "token-index-mismatch" };
  }
  return { ok: true, inputIndex: inputMatches[0]!, outputIndex: outputMatches[0]! };
}

function usdToRawAmount(inputUsd: number, decimals: number, referencePriceUsd: number): bigint | null {
  if (
    !Number.isFinite(inputUsd) ||
    inputUsd <= 0 ||
    inputUsd > Number.MAX_SAFE_INTEGER / 1_000_000 ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 255 ||
    !Number.isFinite(referencePriceUsd) ||
    referencePriceUsd <= 0
  )
    return null;
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

export function encodeCurveCryptoSwapGetDy(input: {
  inputIndex: number;
  outputIndex: number;
  amountInRaw: bigint;
}): `0x${string}` {
  if (
    !Number.isInteger(input.inputIndex) ||
    input.inputIndex < 0 ||
    input.inputIndex > 7 ||
    !Number.isInteger(input.outputIndex) ||
    input.outputIndex < 0 ||
    input.outputIndex > 7 ||
    input.inputIndex === input.outputIndex ||
    input.amountInRaw <= 0n
  )
    throw new Error("Curve CryptoSwap quote indices or amount are invalid");
  return encodeFunctionData({
    abi: CURVE_CRYPTOSWAP_ABI,
    functionName: "get_dy",
    args: [BigInt(input.inputIndex), BigInt(input.outputIndex), input.amountInRaw],
  }).toLowerCase() as `0x${string}`;
}

export function decodeCurveCryptoSwapGetDy(returnData: `0x${string}`): bigint | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(returnData)) return null;
  try {
    return decodeFunctionResult({
      abi: CURVE_CRYPTOSWAP_ABI,
      functionName: "get_dy",
      data: returnData,
    }) as bigint;
  } catch {
    return null;
  }
}

function prepareRequest(
  request: CurveCryptoSwapRequest,
  index: number,
): {
  encoded?: EncodedCurveCryptoSwapRequest;
  failureReason?: CurveCryptoSwapQuoteFailure;
  eligibility: CurveCryptoSwapEligibility;
} {
  const endpointAddress = canonicalAddress(request.endpointAddress);
  const policy = endpointAddress == null ? null : getCurveCryptoSwapShadowPolicy(request.target.chain, endpointAddress);
  const eligibility = evaluateCurveCryptoSwapEligibility({
    chain: request.target.chain,
    endpointAddress: request.endpointAddress,
    policy,
    evidence: request.runtimeEvidence,
  });
  if (!Number.isSafeInteger(request.blockNumber) || request.blockNumber < 0) {
    return { failureReason: "invalid-pinned-block", eligibility };
  }
  if (endpointAddress == null || policy == null) {
    return { failureReason: "unsupported-chain-or-pool", eligibility };
  }
  const indices = resolveCurveCryptoSwapTokenIndices(request.target);
  if (!indices.ok) return { failureReason: indices.reason, eligibility };
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
  if (request.target.targetId !== expectedTargetId) {
    return { failureReason: "invalid-curve-cryptoswap-target", eligibility };
  }
  const amountInRaw = usdToRawAmount(
    request.inputUsd,
    request.target.tokenIn.decimals,
    request.target.tokenIn.referencePriceUsd,
  );
  if (amountInRaw == null) return { failureReason: "invalid-quote-input", eligibility };
  const callData = encodeCurveCryptoSwapGetDy({
    inputIndex: indices.inputIndex,
    outputIndex: indices.outputIndex,
    amountInRaw,
  });
  return {
    eligibility,
    encoded: {
      ...request,
      index,
      label: `${index}:${request.target.targetId}`,
      amountInRaw,
      inputIndex: indices.inputIndex,
      outputIndex: indices.outputIndex,
      callData,
      endpointAddress,
      policy,
      eligibility,
    },
  };
}

export function decodeCurveCryptoSwapQuotePoint(
  request: Pick<
    EncodedCurveCryptoSwapRequest,
    "amountInRaw" | "callData" | "inputIndex" | "outputIndex" | "blockNumber" | "endpointAddress" | "policy" | "target"
  >,
  result: EvmMulticall3Result,
): { point?: DexMeasuredRawQuotePoint; failureReason?: CurveCryptoSwapQuoteFailure } {
  if (!result.success) return { failureReason: "pool-revert" };
  const amountOutRaw = decodeCurveCryptoSwapGetDy(result.returnData);
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
        generation: request.policy.generation,
        shadow: true,
      },
    },
  };
}

async function runWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  run: (value: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        await run(values[index]!);
      }
    }),
  );
}

export function createCurveCryptoSwapQuoteExecutor(dependencies: CurveCryptoSwapQuoteDependencies) {
  async function executeAdaptiveChunk(input: {
    chain: string;
    calls: readonly EvmMulticall3Call[];
    blockNumber: number;
    chainRpcs: Map<string, ChainRpcConfig>;
    signal?: AbortSignal;
  }): Promise<EvmMulticall3Result[]> {
    const result = await dependencies.executeMulticall(input);
    if (result != null) return result;
    if (input.calls.length === 1) {
      return [{ label: input.calls[0]!.label, success: false, returnData: "0x" }];
    }
    const midpoint = Math.ceil(input.calls.length / 2);
    const left = await executeAdaptiveChunk({ ...input, calls: input.calls.slice(0, midpoint) });
    const right = await executeAdaptiveChunk({ ...input, calls: input.calls.slice(midpoint) });
    return [...left, ...right];
  }

  return async function quoteCurveCryptoSwapRequests(input: {
    requests: readonly CurveCryptoSwapRequest[];
    chainRpcs: Map<string, ChainRpcConfig>;
    signal?: AbortSignal;
  }): Promise<CurveCryptoSwapBatchOutcome[]> {
    const prepared = input.requests.map(prepareRequest);
    const outcomes: CurveCryptoSwapBatchOutcome[] = input.requests.map((request, index) => ({
      targetId: request.target.targetId,
      inputUsd: request.inputUsd,
      blockNumber: request.blockNumber,
      eligibility: prepared[index]!.eligibility,
      ...(prepared[index]!.failureReason ? { failureReason: prepared[index]!.failureReason } : {}),
    }));
    const valid = prepared.flatMap((entry) => (entry.encoded ? [entry.encoded] : []));
    const groupsByChain = new Map<string, EncodedCurveCryptoSwapRequest[]>();
    for (const request of valid) {
      const group = groupsByChain.get(request.policy.chain) ?? [];
      group.push(request);
      groupsByChain.set(request.policy.chain, group);
    }

    await runWithConcurrency([...groupsByChain.values()], 3, async (chainRequests) => {
      const requestsByBlock = new Map<number, EncodedCurveCryptoSwapRequest[]>();
      for (const request of chainRequests) {
        const blockRequests = requestsByBlock.get(request.blockNumber) ?? [];
        blockRequests.push(request);
        requestsByBlock.set(request.blockNumber, blockRequests);
      }
      // Each chain lane has at most one in-flight RPC request.
      for (const blockRequests of requestsByBlock.values()) {
        throwIfAborted(input.signal);
        for (let offset = 0; offset < blockRequests.length; offset += CURVE_MULTICALL_BATCH_SIZE) {
          throwIfAborted(input.signal);
          const chunk = blockRequests.slice(offset, offset + CURVE_MULTICALL_BATCH_SIZE);
          const calls = chunk.map((request) => ({
            label: request.label,
            target: request.endpointAddress,
            callData: request.callData,
            allowFailure: true,
          }));
          const results = await executeAdaptiveChunk({
            chain: chunk[0]!.policy.chain,
            calls,
            blockNumber: chunk[0]!.blockNumber,
            chainRpcs: input.chainRpcs,
            signal: input.signal,
          });
          const byLabel = new Map(results.map((result) => [result.label, result]));
          for (const request of chunk) {
            const result = byLabel.get(request.label);
            const decoded =
              result == null
                ? { failureReason: "pool-revert" as const }
                : decodeCurveCryptoSwapQuotePoint(request, result);
            outcomes[request.index] = {
              targetId: request.target.targetId,
              inputUsd: request.inputUsd,
              blockNumber: request.blockNumber,
              eligibility: request.eligibility,
              ...decoded,
            };
          }
        }
      }
    });
    return outcomes;
  };
}

export const quoteCurveCryptoSwapRequests = createCurveCryptoSwapQuoteExecutor({
  executeMulticall: async (input) =>
    fetchEvmMulticall3Aggregate3AtBlock(input.chain, input.calls, input.blockNumber, {
      chainRpcs: input.chainRpcs,
      signal: input.signal,
      timeoutMs: 30_000,
      maxRetries: 1,
      gas: CURVE_MULTICALL_GAS,
      multicallBatchSize: Math.min(CURVE_MULTICALL_BATCH_SIZE, input.calls.length),
    }),
});

/** Exact ABI-bound validation; score eligibility is checked separately. */
export function validateCurveCryptoSwapProfileProof(profile: DexMeasuredExecutionProfile): string[] {
  const issues = new Set<string>();
  if (profile.adapterProfileId !== CURVE_CRYPTOSWAP_ADAPTER_PROFILE_ID) issues.add("wrong-adapter-profile");
  const endpointAddress = canonicalAddress(profile.executionEndpoint.address);
  const policy = endpointAddress == null ? null : getCurveCryptoSwapShadowPolicy(profile.chain, endpointAddress);
  if (policy == null) issues.add("execution-pool-not-in-cohort");
  const indices = resolveCurveCryptoSwapTokenIndices(profile);
  if (!indices.ok) issues.add(indices.reason);

  for (const point of profile.quoteProof) {
    try {
      const decodedCall = decodeFunctionData({
        abi: CURVE_CRYPTOSWAP_ABI,
        data: point.callData as `0x${string}`,
      });
      if (decodedCall.functionName !== "get_dy") {
        issues.add("wrong-function-selector");
        continue;
      }
      const [inputIndex, outputIndex, amountInRaw] = decodedCall.args;
      if (
        !indices.ok ||
        inputIndex !== BigInt(indices.inputIndex) ||
        outputIndex !== BigInt(indices.outputIndex) ||
        amountInRaw.toString() !== point.amountInRaw
      )
        issues.add("call-data-mismatch");

      const amountOutRaw = decodeCurveCryptoSwapGetDy(point.returnData as `0x${string}`);
      if (amountOutRaw == null) issues.add("abi-decode-failed");
      else if (amountOutRaw.toString() !== point.amountOutRaw) issues.add("return-data-mismatch");
    } catch {
      issues.add("abi-decode-failed");
    }
  }
  return [...issues];
}

/**
 * Generic dispatcher surface. It intentionally refuses to publish shadow
 * points until the cohort policies become score-eligible.
 */
export const CURVE_CRYPTOSWAP_ADAPTER: DexMeasuredExecutionAdapter = {
  profileId: CURVE_CRYPTOSWAP_ADAPTER_PROFILE_ID,
  async quotePoints(input) {
    const eligibility = evaluateCurveCryptoSwapEligibility({
      chain: input.target.chain,
      endpointAddress: input.endpointAddress,
    });
    if (!eligibility.ok) {
      return {
        points: [],
        failures: input.inputNotionalsUsd.map((inputUsd) => ({
          inputUsd,
          reason: eligibility.reason,
        })),
      };
    }
    const outcomes = await quoteCurveCryptoSwapRequests({
      requests: input.inputNotionalsUsd.map((inputUsd) => ({
        target: input.target,
        inputUsd,
        blockNumber: input.blockNumber,
        endpointAddress: input.endpointAddress,
      })),
      chainRpcs: input.chainRpcs,
      signal: input.signal,
    });
    return {
      points: outcomes.flatMap((outcome) => (outcome.point && outcome.eligibility.ok ? [outcome.point] : [])),
      failures: outcomes.flatMap((outcome) => {
        const reason = outcome.failureReason ?? (outcome.eligibility.ok ? null : outcome.eligibility.reason);
        return reason == null ? [] : [{ inputUsd: outcome.inputUsd, reason }];
      }),
    };
  },
};
