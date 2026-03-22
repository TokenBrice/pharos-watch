import type { LiveReserveWarning, ReserveSlice } from "@shared/types";
import type { LiveReserveFeedClass } from "@shared/lib/live-reserve-adapters";
import { isReserveRisk } from "./helpers";

interface ValidationInput {
  slices: ReserveSlice[];
}

interface ValidationResult {
  valid: boolean;
  warnings: LiveReserveWarning[];
}

interface ValidationOptions {
  feedClass?: LiveReserveFeedClass;
}

const PCT_SUM_WARNING_TOLERANCE = 0.5;
const PCT_SUM_ERROR_TOLERANCE = 2;

export function validateAdapterOutput(
  input: ValidationInput,
  options?: ValidationOptions,
): ValidationResult {
  if (input.slices.length === 0) {
    return { valid: false, warnings: [{ code: "empty-slices", message: "Adapter returned zero reserve slices", severity: "warning" }] };
  }

  const warnings: LiveReserveWarning[] = [];

  for (const slice of input.slices) {
    if (!Number.isFinite(slice.pct) || slice.pct < 0) {
      return { valid: false, warnings: [{ code: "invalid-pct", message: `Slice "${slice.name}" has invalid pct: ${slice.pct}`, severity: "warning" }] };
    }
    if (!isReserveRisk(slice.risk)) {
      return { valid: false, warnings: [{ code: "invalid-risk", message: `Slice "${slice.name}" has invalid risk: ${slice.risk}`, severity: "warning" }] };
    }
  }

  const sum = input.slices.reduce((s, r) => s + r.pct, 0);
  const deviation = Math.abs(sum - 100);
  const feedClassLabel = options?.feedClass ? ` for ${options.feedClass}` : "";
  if (deviation > PCT_SUM_ERROR_TOLERANCE) {
    return {
      valid: false,
      warnings: [{
        code: "pct-sum-deviation",
        message: `Slice percentages sum to ${sum.toFixed(1)}%${feedClassLabel} (expected 100% ± ${PCT_SUM_ERROR_TOLERANCE}%)`,
        severity: "warning",
      }],
    };
  }
  if (deviation > PCT_SUM_WARNING_TOLERANCE) {
    warnings.push({
      code: "pct-sum-deviation",
      message: `Slice percentages sum to ${sum.toFixed(1)}%${feedClassLabel} (expected 100% ± ${PCT_SUM_WARNING_TOLERANCE}%)`,
      severity: "warning",
    });
  }

  return { valid: true, warnings };
}
