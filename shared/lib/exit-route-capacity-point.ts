import type { ExitRouteCapacityPoint } from "../types/exit-route";

export interface ExitRouteCapacityPointOptions {
  /** Clamp negative capacity to zero. When false, negative capacity is rejected. */
  clampNegativeCapacity: boolean;
  /** Decimal places for published USD values, or null to preserve full precision. */
  usdDecimals: number | null;
  /** Decimal places for completion ratios, or null to preserve full precision. */
  ratioDecimals: number | null;
}

export interface ExitRouteCapacityPointInput {
  requestedNotionalUsd: number;
  maxCostBps: number;
  capacityUsd: number;
  /** A producer-side cost/admissibility gate may zero capacity before publication. */
  admitted?: boolean;
  executionCostBps?: number;
}

function roundDecimal(value: number, decimals: number | null, label: string): number {
  if (decimals == null) return value;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 12) {
    throw new RangeError(`${label} decimals must be an integer from 0 to 12 or null`);
  }
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

/**
 * Canonical exit-capacity point construction. Producers must state their numeric
 * publication policy explicitly while sharing clamping, request capping, and ratio math.
 */
export function buildExitRouteCapacityPoint(
  input: ExitRouteCapacityPointInput,
  options: ExitRouteCapacityPointOptions,
): ExitRouteCapacityPoint {
  const { requestedNotionalUsd, maxCostBps, executionCostBps } = input;
  if (!Number.isFinite(requestedNotionalUsd) || requestedNotionalUsd <= 0) {
    throw new RangeError("requestedNotionalUsd must be finite and positive");
  }
  if (!Number.isFinite(maxCostBps) || maxCostBps < 0) {
    throw new RangeError("maxCostBps must be finite and nonnegative");
  }
  if (!Number.isFinite(input.capacityUsd)) {
    throw new RangeError("capacityUsd must be finite");
  }
  if (input.capacityUsd < 0 && !options.clampNegativeCapacity) {
    throw new RangeError("capacityUsd must be nonnegative when clamping is disabled");
  }
  if (executionCostBps != null && (!Number.isFinite(executionCostBps) || executionCostBps < 0)) {
    throw new RangeError("executionCostBps must be finite and nonnegative");
  }

  const nonnegativeCapacityUsd = Math.max(0, input.capacityUsd);
  const admittedCapacityUsd = input.admitted === false ? 0 : nonnegativeCapacityUsd;
  const executableUsd = Math.min(
    requestedNotionalUsd,
    roundDecimal(Math.min(requestedNotionalUsd, admittedCapacityUsd), options.usdDecimals, "USD"),
  );
  const completionRatio = Math.min(
    1,
    Math.max(0, roundDecimal(executableUsd / requestedNotionalUsd, options.ratioDecimals, "ratio")),
  );
  if (executionCostBps != null && executableUsd > 0 && executionCostBps > maxCostBps) {
    throw new RangeError("executionCostBps cannot exceed maxCostBps for admitted capacity");
  }

  return {
    requestedNotionalUsd,
    maxCostBps,
    executableUsd,
    completionRatio,
    ...(executionCostBps != null && executableUsd > 0 ? { executionCostBps } : {}),
  };
}
