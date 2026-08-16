import { DEX_MEASURED_MAX_COST_BPS } from "@shared/types/measured-execution";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { throwIfAborted } from "../../lib/abort";
import { mapWithConcurrency } from "../../lib/concurrency";
import type { EvmMulticall3Call, EvmMulticall3Result } from "../../lib/evm-rpc";
import { executeAdaptiveMulticall } from "./adaptive-multicall";
import { rawAmountToUsdOrNull } from "./fixed-point";
import type {
  DexMeasuredExecutionBudgetStopReason,
  DexMeasuredExecutionRpcBudget,
  DexMeasuredRawQuotePoint,
} from "./profiles";

const MAX_CONCURRENT_EVM_CHAIN_LANES = 3;

interface QuoteTokenAmount {
  decimals: number;
  referencePriceUsd: number;
}

export interface EvmQuotePlanItem {
  index: number;
  label: string;
  chain: string;
  blockNumber: number;
  call: EvmMulticall3Call;
}

export interface EvmQuotePlanBatchInput {
  chain: string;
  calls: readonly EvmMulticall3Call[];
  blockNumber: number;
  chainRpcs: Map<string, ChainRpcConfig>;
  signal?: AbortSignal;
  rpcBudget?: DexMeasuredExecutionRpcBudget;
  onBudgetStop?: (reason: DexMeasuredExecutionBudgetStopReason) => void;
}

export interface EvmQuotePlanSpec<TPlan extends EvmQuotePlanItem, TOutcome> {
  batchSize: number;
  beforeBlock?(input: {
    plans: readonly TPlan[];
    chain: string;
    blockNumber: number;
    chainRpcs: Map<string, ChainRpcConfig>;
    signal?: AbortSignal;
    rpcBudget?: DexMeasuredExecutionRpcBudget;
  }): Promise<{ ok: true } | { ok: false; materialize(plan: TPlan): TOutcome }>;
  executeMulticall(input: EvmQuotePlanBatchInput): Promise<readonly EvmMulticall3Result[] | null>;
  resolveResult(plan: TPlan, result: EvmMulticall3Result): TOutcome;
  materializeTransportFailure(
    plan: TPlan,
    reason: DexMeasuredExecutionBudgetStopReason | null,
  ): TOutcome;
  adaptive?: {
    failedAttemptAccounting: "all" | "single-call";
    unattemptedResult: "failure-result" | "omit";
    retryFailedCallsIndividually?: boolean;
  };
}

export async function executeEvmQuotePlan<TPlan extends EvmQuotePlanItem, TOutcome>(input: {
  plans: readonly TPlan[];
  outcomes: TOutcome[];
  chainRpcs: Map<string, ChainRpcConfig>;
  signal?: AbortSignal;
  rpcBudget?: DexMeasuredExecutionRpcBudget;
  spec: EvmQuotePlanSpec<TPlan, TOutcome>;
}): Promise<TOutcome[]> {
  if (!Number.isSafeInteger(input.spec.batchSize) || input.spec.batchSize <= 0) {
    throw new TypeError("EVM quote-plan batch size must be a positive safe integer");
  }

  const plansByChain = new Map<string, TPlan[]>();
  for (const plan of input.plans) {
    const chainPlans = plansByChain.get(plan.chain) ?? [];
    chainPlans.push(plan);
    plansByChain.set(plan.chain, chainPlans);
  }

  await mapWithConcurrency([...plansByChain.entries()], MAX_CONCURRENT_EVM_CHAIN_LANES, async ([chain, chainPlans]) => {
    const plansByBlock = new Map<number, TPlan[]>();
    for (const plan of chainPlans) {
      const blockPlans = plansByBlock.get(plan.blockNumber) ?? [];
      blockPlans.push(plan);
      plansByBlock.set(plan.blockNumber, blockPlans);
    }

    // A chain lane owns one request at a time. Pinned-block groups, batches,
    // adaptive fragments, and singleton retries are therefore all serialized.
    for (const [blockNumber, blockPlans] of plansByBlock) {
      throwIfAborted(input.signal);
      const blockReadiness = await input.spec.beforeBlock?.({
        plans: blockPlans,
        chain,
        blockNumber,
        chainRpcs: input.chainRpcs,
        signal: input.signal,
        rpcBudget: input.rpcBudget,
      });
      if (blockReadiness?.ok === false) {
        for (const plan of blockPlans) input.outcomes[plan.index] = blockReadiness.materialize(plan);
        continue;
      }
      for (let offset = 0; offset < blockPlans.length; offset += input.spec.batchSize) {
        throwIfAborted(input.signal);
        const chunk = blockPlans.slice(offset, offset + input.spec.batchSize);
        const calls = chunk.map((plan) => plan.call);
        const resultsByLabel = new Map<string, EvmMulticall3Result>();
        const transportFailureLabels = new Set<string>();
        const budgetStopReasonsByLabel = new Map<string, DexMeasuredExecutionBudgetStopReason>();

        if (input.spec.adaptive) {
          const executeAdaptive = async (adaptiveCalls: readonly EvmMulticall3Call[]) =>
            executeAdaptiveMulticall<EvmMulticall3Call, EvmMulticall3Result>({
              chain,
              calls: adaptiveCalls,
              blockNumber,
              signal: input.signal,
              execute: ({ chain: requestChain, calls: requestCalls, blockNumber: requestBlock, signal, onBudgetStop }) =>
                input.spec.executeMulticall({
                  chain: requestChain,
                  calls: requestCalls,
                  blockNumber: requestBlock,
                  chainRpcs: input.chainRpcs,
                  signal,
                  rpcBudget: input.rpcBudget,
                  onBudgetStop,
                }),
              failureResult: (call) => ({ label: call.label, success: false, returnData: "0x" }),
              getLabel: (call) => call.label,
              ...(input.rpcBudget
                ? { deadlineMs: input.rpcBudget.deadlineMs, budget: input.rpcBudget }
                : {}),
              failedAttemptAccounting: input.spec.adaptive!.failedAttemptAccounting,
              unattemptedResult: input.spec.adaptive!.unattemptedResult,
            });

          const initial = await executeAdaptive(calls);
          for (const result of initial.results) resultsByLabel.set(result.label, result);
          for (const label of initial.unattemptedLabels) transportFailureLabels.add(label);
          for (const [label, reason] of initial.budgetStopReasonsByLabel) {
            budgetStopReasonsByLabel.set(label, reason);
          }

          if (input.spec.adaptive.retryFailedCallsIndividually) {
            for (const call of calls) {
              if (resultsByLabel.get(call.label)?.success) continue;
              throwIfAborted(input.signal);
              const retry = await executeAdaptive([call]);
              for (const result of retry.results) resultsByLabel.set(result.label, result);
              for (const [label, reason] of retry.budgetStopReasonsByLabel) {
                budgetStopReasonsByLabel.set(label, reason);
              }
              if (retry.unattemptedLabels.includes(call.label)) transportFailureLabels.add(call.label);
              else transportFailureLabels.delete(call.label);
            }
          }
        } else if (input.rpcBudget && !input.rpcBudget.canRequestChain(chain)) {
          const reason = input.rpcBudget.stopReason;
          for (const plan of chunk) input.outcomes[plan.index] = input.spec.materializeTransportFailure(plan, reason);
          continue;
        } else {
          const results = await input.spec.executeMulticall({
            chain,
            calls,
            blockNumber,
            chainRpcs: input.chainRpcs,
            signal: input.signal,
            rpcBudget: input.rpcBudget,
          });
          input.rpcBudget?.recordChainResult(chain, results != null);
          if (results == null) {
            const reason = input.rpcBudget?.stopReason ?? null;
            for (const plan of chunk) input.outcomes[plan.index] = input.spec.materializeTransportFailure(plan, reason);
            continue;
          }
          for (const result of results) resultsByLabel.set(result.label, result);
        }

        for (const plan of chunk) {
          const budgetReason = budgetStopReasonsByLabel.get(plan.label) ?? null;
          const result = resultsByLabel.get(plan.label);
          input.outcomes[plan.index] =
            budgetReason != null || result == null || transportFailureLabels.has(plan.label)
              ? input.spec.materializeTransportFailure(plan, budgetReason)
              : input.spec.resolveResult(plan, result);
        }
      }
    }
  });
  return input.outcomes;
}

export function materializeEvmQuotePoint(input: {
  amountInRaw: bigint;
  amountOutRaw: bigint;
  callData: string;
  returnData: string;
  tokenIn: QuoteTokenAmount;
  tokenOut: QuoteTokenAmount;
  adapterMetadata: Record<string, string | number | boolean>;
  reverted?: boolean;
}): DexMeasuredRawQuotePoint | null {
  const inputUsd = rawAmountToUsdOrNull(
    input.amountInRaw,
    input.tokenIn.decimals,
    input.tokenIn.referencePriceUsd,
  );
  const outputUsd = rawAmountToUsdOrNull(
    input.amountOutRaw,
    input.tokenOut.decimals,
    input.tokenOut.referencePriceUsd,
  );
  if (inputUsd == null || inputUsd <= 0 || outputUsd == null || outputUsd < 0) return null;
  const costBps = Math.max(0, (1 - outputUsd / inputUsd) * 10_000);
  return {
    amountInRaw: input.amountInRaw.toString(),
    amountOutRaw: input.amountOutRaw.toString(),
    callData: input.callData.toLowerCase(),
    returnData: input.returnData.toLowerCase() as `0x${string}`,
    inputUsd,
    outputUsd,
    costBps,
    passesCostBound: costBps <= DEX_MEASURED_MAX_COST_BPS,
    ...(input.reverted ? { reverted: true } : {}),
    adapterMetadata: input.adapterMetadata,
  };
}
