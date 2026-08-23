import type { ChainRpcConfig } from "../../lib/chain-registry";
import type { EvmMulticall3Call, EvmMulticall3Result } from "../../lib/evm-rpc";
import { executeEvmQuotePlan, type EvmQuotePlanItem } from "./evm-quote-plan";
import type {
  DexMeasuredExecutionBudgetStopReason,
  DexMeasuredExecutionRpcBudget,
} from "./profiles";

interface CurveGetDyQuoteEngineInput<TRequest> {
  requests: readonly TRequest[];
  chainRpcs: Map<string, ChainRpcConfig>;
  signal?: AbortSignal;
  rpcBudget?: DexMeasuredExecutionRpcBudget;
}

interface CurveGetDyQuoteEnginePrepared<TPlan, TEligibility, TFailure extends string> {
  plan?: TPlan;
  eligibility: TEligibility;
  failureReason?: TFailure;
}

export type CurveGetDyPlan<T> = T & {
  chain: string;
  call: EvmMulticall3Call;
};

export function makeCurveGetDyPlan<
  T extends {
    label: string;
    endpointAddress: `0x${string}`;
    callData: `0x${string}`;
    policy: { chain: string };
  },
>(encoded: T): CurveGetDyPlan<T> {
  return {
    ...encoded,
    chain: encoded.policy.chain,
    call: {
      label: encoded.label,
      target: encoded.endpointAddress,
      callData: encoded.callData,
      allowFailure: true,
    },
  };
}

interface CurveGetDyQuoteEngineDescriptor<
  TRequest,
  TPlan extends EvmQuotePlanItem,
  TEligibility,
  TOutcome,
  TFailure extends string,
> {
  batchSize: number;
  prepare(
    request: TRequest,
    index: number,
  ): CurveGetDyQuoteEnginePrepared<TPlan, TEligibility, TFailure>;
  makeOutcome(
    request: TRequest,
    eligibility: TEligibility,
    failureReason?: TFailure,
  ): TOutcome;
  executeMulticall(input: {
    chain: string;
    calls: TPlan["call"][];
    blockNumber: number;
    chainRpcs: Map<string, ChainRpcConfig>;
    signal?: AbortSignal;
    rpcBudget?: DexMeasuredExecutionRpcBudget;
  }): Promise<readonly EvmMulticall3Result[] | null>;
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

export function createCurveGetDyQuoteAdapter<
  TRequest,
  TPlan extends EvmQuotePlanItem,
  TEligibility,
  TOutcome,
  TFailure extends string,
>(descriptor: CurveGetDyQuoteEngineDescriptor<TRequest, TPlan, TEligibility, TOutcome, TFailure>) {
  return async function quoteCurveGetDyRequests(
    input: CurveGetDyQuoteEngineInput<TRequest>,
  ): Promise<TOutcome[]> {
    const prepared = input.requests.map((request, index) => descriptor.prepare(request, index));
    const outcomes = input.requests.map((request, index) =>
      descriptor.makeOutcome(
        request,
        prepared[index]!.eligibility,
        prepared[index]!.failureReason,
      ),
    );
    const plans = prepared.flatMap((entry) => entry.plan ? [entry.plan] : []);
    return executeEvmQuotePlan({
      plans,
      outcomes,
      chainRpcs: input.chainRpcs,
      signal: input.signal,
      rpcBudget: input.rpcBudget,
      spec: {
        batchSize: descriptor.batchSize,
        executeMulticall: descriptor.executeMulticall,
        ...(descriptor.adaptive ? { adaptive: descriptor.adaptive } : {}),
        resolveResult: descriptor.resolveResult,
        materializeTransportFailure: descriptor.materializeTransportFailure,
      },
    });
  };
}
