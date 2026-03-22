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

function infoWarning(code: string, message: string): LiveReserveWarning {
  return { code, message, severity: "info", effect: "info" };
}

function degradedWarning(code: string, message: string): LiveReserveWarning {
  return { code, message, severity: "warning", effect: "degraded" };
}

function fatalWarning(code: string, message: string): LiveReserveWarning {
  return { code, message, severity: "warning", effect: "fatal" };
}

function getFiniteMetadataNumber(metadata: Record<string, unknown> | undefined, key: string): number | null {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function validateAdapterOutput(
  input: ValidationInput,
  options?: ValidationOptions,
): ValidationResult {
  if (input.slices.length === 0) {
    return { valid: false, warnings: [fatalWarning("empty-slices", "Adapter returned zero reserve slices")] };
  }

  const warnings: LiveReserveWarning[] = [];

  for (const slice of input.slices) {
    if (!Number.isFinite(slice.pct) || slice.pct < 0) {
      return { valid: false, warnings: [fatalWarning("invalid-pct", `Slice "${slice.name}" has invalid pct: ${slice.pct}`)] };
    }
    if (!isReserveRisk(slice.risk)) {
      return { valid: false, warnings: [fatalWarning("invalid-risk", `Slice "${slice.name}" has invalid risk: ${slice.risk}`)] };
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
      warnings: [fatalWarning(
        "pct-sum-deviation",
        `Slice percentages sum to ${sum.toFixed(1)}%${adapterLabel} (expected 100% ± ${PCT_SUM_ERROR_TOLERANCE}%)`,
      )],
    };
  }
  if (deviation > PCT_SUM_WARNING_TOLERANCE) {
    warnings.push(degradedWarning(
      "pct-sum-deviation",
      `Slice percentages sum to ${sum.toFixed(1)}%${adapterLabel} (expected 100% ± ${PCT_SUM_WARNING_TOLERANCE}%)`,
    ));
  }

  const now = options?.now ?? Math.floor(Date.now() / 1000);
  const maxSourceAgeSec = options?.adapter?.validation?.maxSourceAgeSec;
  const sourceTimestamp = getFiniteMetadataNumber(input.metadata, "sourceTimestamp");
  if (maxSourceAgeSec != null && sourceTimestamp != null) {
    const ageSec = Math.max(0, now - sourceTimestamp);
    if (ageSec > maxSourceAgeSec) {
      warnings.push(degradedWarning(
        "stale-source-data",
        `Upstream reserve source timestamp is ${ageSec}s old${adapterLabel} (max ${maxSourceAgeSec}s)`,
      ));
    }
  }

  const maxUnknownExposurePct = options?.adapter?.validation?.maxUnknownExposurePct;
  const unknownExposurePct = getFiniteMetadataNumber(input.metadata, "unknownExposurePct");
  if (
    maxUnknownExposurePct != null
    && unknownExposurePct != null
    && unknownExposurePct > maxUnknownExposurePct
  ) {
    warnings.push(degradedWarning(
      "material-unknown-exposure",
      `Unknown reserve exposure is ${unknownExposurePct.toFixed(2)}%${adapterLabel} `
      + `(max ${maxUnknownExposurePct.toFixed(2)}%)`,
    ));
  }

  const freshnessMode = input.metadata?.freshnessMode;
  if (maxSourceAgeSec != null && sourceTimestamp == null && freshnessMode === "unverified") {
    warnings.push(infoWarning(
      "freshness-unverified",
      `Upstream reserve source timestamp is unavailable${adapterLabel}; freshness remains unverified`,
    ));
  }

  return { valid: true, warnings };
}

export function hasDegradingWarnings(warnings: readonly LiveReserveWarning[] | undefined): boolean {
  return (warnings ?? []).some((warning) => warning.effect === "degraded");
}

export function hasFatalWarnings(warnings: readonly LiveReserveWarning[] | undefined): boolean {
  return (warnings ?? []).some((warning) => warning.effect === "fatal");
}
