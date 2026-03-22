import type { LiveReserveWarning, ReserveSlice } from "@shared/types";
import type { ReserveAdapterDefinition } from "./types";
import { isReserveRisk } from "./helpers";

interface ValidationInput {
  slices: ReserveSlice[];
  metadata?: Record<string, unknown>;
}

interface ValidationResult {
  valid: boolean;
  warnings: LiveReserveWarning[];
}

interface ValidationOptions {
  adapter?: ReserveAdapterDefinition;
  now?: number;
}

const PCT_SUM_WARNING_TOLERANCE = 0.5;
const PCT_SUM_ERROR_TOLERANCE = 2;

function getFiniteMetadataNumber(metadata: Record<string, unknown> | undefined, key: string): number | null {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

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
  const adapterLabel = options?.adapter
    ? ` for ${options.adapter.sourceModel}/${options.adapter.evidenceClass}`
    : "";
  if (deviation > PCT_SUM_ERROR_TOLERANCE) {
    return {
      valid: false,
      warnings: [{
        code: "pct-sum-deviation",
        message: `Slice percentages sum to ${sum.toFixed(1)}%${adapterLabel} (expected 100% ± ${PCT_SUM_ERROR_TOLERANCE}%)`,
        severity: "warning",
      }],
    };
  }
  if (deviation > PCT_SUM_WARNING_TOLERANCE) {
    warnings.push({
      code: "pct-sum-deviation",
      message: `Slice percentages sum to ${sum.toFixed(1)}%${adapterLabel} (expected 100% ± ${PCT_SUM_WARNING_TOLERANCE}%)`,
      severity: "warning",
    });
  }

  const now = options?.now ?? Math.floor(Date.now() / 1000);
  const maxSourceAgeSec = options?.adapter?.validation?.maxSourceAgeSec;
  const sourceTimestamp = getFiniteMetadataNumber(input.metadata, "sourceTimestamp");
  if (maxSourceAgeSec != null && sourceTimestamp != null) {
    const ageSec = Math.max(0, now - sourceTimestamp);
    if (ageSec > maxSourceAgeSec) {
      warnings.push({
        code: "stale-source-data",
        message: `Upstream reserve source timestamp is ${ageSec}s old${adapterLabel} (max ${maxSourceAgeSec}s)`,
        severity: "warning",
      });
    }
  }

  const maxUnknownExposurePct = options?.adapter?.validation?.maxUnknownExposurePct;
  const unknownExposurePct = getFiniteMetadataNumber(input.metadata, "unknownExposurePct");
  if (
    maxUnknownExposurePct != null
    && unknownExposurePct != null
    && unknownExposurePct > maxUnknownExposurePct
  ) {
    warnings.push({
      code: "material-unknown-exposure",
      message:
        `Unknown reserve exposure is ${unknownExposurePct.toFixed(2)}%${adapterLabel} `
        + `(max ${maxUnknownExposurePct.toFixed(2)}%)`,
      severity: "warning",
    });
  }

  return { valid: true, warnings };
}
