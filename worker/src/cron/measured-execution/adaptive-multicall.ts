import type { DexMeasuredExecutionBudgetStopReason } from "./profiles";

export interface AdaptiveMulticallBudget {
  canRequestChain(chain: string): boolean;
  recordChainResult(chain: string, success: boolean): void;
}

export interface AdaptiveMulticallExecutorInput<TCall> {
  chain: string;
  calls: readonly TCall[];
  blockNumber: number;
  signal?: AbortSignal;
  onBudgetStop?: (reason: DexMeasuredExecutionBudgetStopReason) => void;
}

export interface AdaptiveMulticallResult<TResult> {
  results: TResult[];
  unattemptedLabels: string[];
  budgetStopReasonsByLabel: Map<string, DexMeasuredExecutionBudgetStopReason>;
}

export interface ExecuteAdaptiveMulticallInput<TCall, TResult> {
  chain: string;
  calls: readonly TCall[];
  blockNumber: number;
  signal?: AbortSignal;
  execute(input: AdaptiveMulticallExecutorInput<TCall>): Promise<readonly TResult[] | null>;
  failureResult(call: TCall): TResult;
  getLabel(call: TCall): string;
  deadlineMs?: number;
  budget?: AdaptiveMulticallBudget;
  failedAttemptAccounting: "all" | "single-call";
  unattemptedResult: "failure-result" | "omit";
}

export async function executeAdaptiveMulticall<TCall, TResult>(
  input: ExecuteAdaptiveMulticallInput<TCall, TResult>,
): Promise<AdaptiveMulticallResult<TResult>> {
  const labels = input.calls.map(input.getLabel);
  const unattemptedResults = () =>
    input.unattemptedResult === "failure-result" ? input.calls.map(input.failureResult) : [];
  const unattempted = (budgetStopReason?: DexMeasuredExecutionBudgetStopReason): AdaptiveMulticallResult<TResult> => ({
    results: unattemptedResults(),
    unattemptedLabels: labels,
    budgetStopReasonsByLabel: new Map(
      budgetStopReason == null ? [] : labels.map((label) => [label, budgetStopReason]),
    ),
  });

  if (input.calls.length === 0) {
    return { results: [], unattemptedLabels: [], budgetStopReasonsByLabel: new Map() };
  }
  if (input.budget && !input.budget.canRequestChain(input.chain)) return unattempted();

  let budgetStopReason: DexMeasuredExecutionBudgetStopReason | null = null;
  const results = await input.execute({
    chain: input.chain,
    calls: input.calls,
    blockNumber: input.blockNumber,
    signal: input.signal,
    onBudgetStop: (reason) => {
      budgetStopReason = reason;
    },
  });
  if (results != null) {
    input.budget?.recordChainResult(input.chain, true);
    return { results: [...results], unattemptedLabels: [], budgetStopReasonsByLabel: new Map() };
  }
  if (budgetStopReason == null && input.deadlineMs != null && Date.now() >= input.deadlineMs) {
    budgetStopReason = "runtime-deadline-exceeded";
  }
  if (budgetStopReason != null) return unattempted(budgetStopReason);

  if (input.failedAttemptAccounting === "all") input.budget?.recordChainResult(input.chain, false);
  if (input.calls.length === 1) {
    if (input.failedAttemptAccounting === "single-call") input.budget?.recordChainResult(input.chain, false);
    return {
      results: [input.failureResult(input.calls[0]!)],
      unattemptedLabels: labels,
      budgetStopReasonsByLabel: new Map(),
    };
  }

  const midpoint = Math.ceil(input.calls.length / 2);
  const left = await executeAdaptiveMulticall({ ...input, calls: input.calls.slice(0, midpoint) });
  const right = await executeAdaptiveMulticall({ ...input, calls: input.calls.slice(midpoint) });
  return {
    results: [...left.results, ...right.results],
    unattemptedLabels: [...left.unattemptedLabels, ...right.unattemptedLabels],
    budgetStopReasonsByLabel: new Map([
      ...left.budgetStopReasonsByLabel,
      ...right.budgetStopReasonsByLabel,
    ]),
  };
}
