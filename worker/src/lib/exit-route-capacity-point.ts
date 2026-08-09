import { SAME_NOTIONAL_EXIT_REQUEST_POLICY } from "@shared/lib/redemption-backstop-scoring";
import type { ExitRouteCapacityPoint } from "@shared/types/exit-route";

/**
 * One capacity-curve point under the shared same-notional exit request.
 *
 * Every V9 exit-route producer builds points the same way: capacity counts only
 * when the request clears the policy cost ceiling, and the completion ratio is
 * the executable share of the request. The cost gate is optional because some
 * producers (FPI controller) already decided admissibility before calling and
 * pass an already-zeroed capacity.
 *
 * Fail-closed by construction: an underivable cost (`costBps == null`) admits no
 * capacity unless the caller explicitly opts in via `admitUnboundedCost`.
 */
export function buildExitRouteCapacityPoint(args: {
  requestedNotionalUsd: number;
  capacityUsd: number;
  /**
   * All-in cost of this request in bps, or `null` when it cannot be derived.
   * Omit entirely when the caller has already applied its own gate.
   */
  costBps?: number | null;
  /** Admit capacity despite a `null` cost (documented-but-unbounded fee). */
  admitUnboundedCost?: boolean;
  /** Publish the clearing cost on the point alongside the policy ceiling. */
  publishExecutionCost?: boolean;
}): ExitRouteCapacityPoint {
  const { requestedNotionalUsd, capacityUsd, costBps } = args;
  const admitted = costBps === undefined
    ? true
    : (costBps != null && costBps <= SAME_NOTIONAL_EXIT_REQUEST_POLICY.maxCostBps)
      || args.admitUnboundedCost === true;
  const executableUsd = admitted ? Math.min(requestedNotionalUsd, capacityUsd) : 0;
  return {
    requestedNotionalUsd,
    maxCostBps: SAME_NOTIONAL_EXIT_REQUEST_POLICY.maxCostBps,
    executableUsd,
    completionRatio: executableUsd / requestedNotionalUsd,
    ...(args.publishExecutionCost === true && executableUsd > 0 && costBps != null
      ? { executionCostBps: costBps }
      : {}),
  };
}
