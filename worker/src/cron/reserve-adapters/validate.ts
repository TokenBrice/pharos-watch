import type { LiveReserveWarning, ReserveSlice } from "@shared/types";
import { isReserveRisk } from "./helpers";

interface ValidationInput {
  slices: ReserveSlice[];
}

interface ValidationResult {
  valid: boolean;
  warnings: LiveReserveWarning[];
}

const PCT_SUM_TOLERANCE = 5;

export function validateAdapterOutput(input: ValidationInput): ValidationResult {
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
  if (Math.abs(sum - 100) > PCT_SUM_TOLERANCE) {
    warnings.push({
      code: "pct-sum-deviation",
      message: `Slice percentages sum to ${sum.toFixed(1)}% (expected ~100%)`,
      severity: "warning",
    });
  }

  return { valid: true, warnings };
}
