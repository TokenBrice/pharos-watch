import type { ReserveSlice } from "@shared/types/core";
import type { LiveReserveWarning } from "@shared/types/live-reserves";
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

function getMetadataDetails(metadata: Record<string, unknown> | undefined): Record<string, unknown> | null {
  const details = metadata?.details;
  return details && typeof details === "object" && !Array.isArray(details)
    ? details as Record<string, unknown>
    : null;
}

function getMetadataObject(metadata: Record<string, unknown> | undefined, key: string): Record<string, unknown> | null {
  const value = metadata?.[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function describeAdapter(adapter: ReserveAdapterDefinition | undefined): string {
  return adapter ? ` for ${adapter.sourceModel}/${adapter.evidenceClass}` : "";
}

function validateRedemptionTelemetry(
  metadata: Record<string, unknown> | undefined,
  adapter: ReserveAdapterDefinition | undefined,
): LiveReserveWarning[] {
  const warnings: LiveReserveWarning[] = [];
  const adapterLabel = describeAdapter(adapter);
  const redemption = getMetadataObject(metadata, "redemption");
  const capacityUsd = getFiniteMetadataNumber(metadata, "immediateRedeemableUsd")
    ?? getFiniteMetadataNumber(redemption ?? undefined, "capacityUsd");
  const capacityRatio = getFiniteMetadataNumber(metadata, "immediateRedeemableRatio")
    ?? getFiniteMetadataNumber(redemption ?? undefined, "capacityRatioOfSupply");
  const feeBps = getFiniteMetadataNumber(metadata, "redemptionFeeBps")
    ?? getFiniteMetadataNumber(redemption ?? undefined, "feeBps");

  const hasCapacityTelemetry = capacityUsd != null || capacityRatio != null;
  const hasFeeTelemetry = feeBps != null;
  const adapterCapacity = adapter?.redemptionTelemetry?.capacity ?? "none";
  const adapterFee = adapter?.redemptionTelemetry?.fee ?? "none";

  if (capacityUsd != null && capacityUsd < 0) {
    return [fatalWarning("invalid-redemption-capacity-usd", `Redemption capacity is negative${adapterLabel}`)];
  }
  if (capacityRatio != null && (capacityRatio < 0 || capacityRatio > 1)) {
    return [fatalWarning("invalid-redemption-capacity-ratio", `Redemption capacity ratio is outside 0-1${adapterLabel}`)];
  }
  if (feeBps != null && feeBps < 0) {
    return [fatalWarning("invalid-redemption-fee-bps", `Redemption fee bps is negative${adapterLabel}`)];
  }
  if (hasCapacityTelemetry && adapterCapacity === "none") {
    return [fatalWarning("unsupported-redemption-capacity-telemetry", `Adapter emitted redemption capacity despite declaring no capacity telemetry${adapterLabel}`)];
  }
  if (hasFeeTelemetry && adapterFee === "none") {
    return [fatalWarning("unsupported-redemption-fee-telemetry", `Adapter emitted redemption fee despite declaring no fee telemetry${adapterLabel}`)];
  }

  const capacityKind = redemption?.capacityKind;
  if (
    typeof capacityKind === "string" &&
    (capacityKind === "live-direct" || capacityKind === "live-direct-bounded") &&
    adapterCapacity !== "direct"
  ) {
    return [fatalWarning("redemption-capacity-kind-mismatch", `Adapter emitted ${capacityKind} capacity without direct telemetry capability${adapterLabel}`)];
  }

  const freshnessKind = redemption?.freshnessKind;
  if (hasCapacityTelemetry && freshnessKind === "unverified") {
    warnings.push(degradedWarning(
      "redemption-capacity-unverified",
      `Redemption capacity telemetry is marked unverified${adapterLabel}`,
    ));
  }

  return warnings;
}

export function validateAdapterOutput(
  input: ValidationInput,
  options?: ValidationOptions,
): ValidationResult {
  if (input.slices.length === 0) {
    return { valid: false, warnings: [fatalWarning("empty-slices", "Adapter returned zero reserve slices")] };
  }

  const warnings: LiveReserveWarning[] = [];
  const redemptionWarnings = validateRedemptionTelemetry(input.metadata, options?.adapter);
  if (hasFatalWarnings(redemptionWarnings)) {
    return { valid: false, warnings: redemptionWarnings };
  }
  warnings.push(...redemptionWarnings);

  for (const slice of input.slices) {
    if (!Number.isFinite(slice.pct) || slice.pct <= 0) {
      return { valid: false, warnings: [fatalWarning("invalid-pct", `Slice "${slice.name}" has invalid pct: ${slice.pct}`)] };
    }
    if (!isReserveRisk(slice.risk)) {
      return { valid: false, warnings: [fatalWarning("invalid-risk", `Slice "${slice.name}" has invalid risk: ${slice.risk}`)] };
    }
  }

  const sum = input.slices.reduce((s, r) => s + r.pct, 0);
  const deviation = Math.abs(sum - 100);
  const adapterLabel = describeAdapter(options?.adapter);
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
  const allowedFreshnessModes = options?.adapter?.validation?.allowedFreshnessModes;
  if (
    Array.isArray(allowedFreshnessModes)
    && allowedFreshnessModes.length > 0
    && typeof freshnessMode === "string"
    && !allowedFreshnessModes.includes(freshnessMode as (typeof allowedFreshnessModes)[number])
  ) {
    warnings.push(degradedWarning(
      "freshness-mode-disallowed",
      `Live reserve output emitted freshnessMode=${freshnessMode}${adapterLabel}, allowed modes: ${allowedFreshnessModes.join(", ")}`,
    ));
  }

  if (options?.adapter?.evidenceClass === "independent") {
    if (freshnessMode === "verified" && sourceTimestamp == null) {
      return {
        valid: false,
        warnings: [fatalWarning(
          "verified-freshness-missing-source-timestamp",
          `Independent live reserve output marked freshness as verified without sourceTimestamp${adapterLabel}`,
        )],
      };
    }

    if (sourceTimestamp != null && freshnessMode == null) {
      warnings.push(degradedWarning(
        "freshness-mode-missing",
        `Independent live reserve output is missing freshnessMode despite providing sourceTimestamp${adapterLabel}`,
      ));
    }

    if (sourceTimestamp == null && freshnessMode == null) {
      warnings.push(degradedWarning(
        "freshness-metadata-missing",
        `Independent live reserve output omitted explicit freshness metadata${adapterLabel}`,
      ));
    }

    if (freshnessMode === "unverified") {
      const details = getMetadataDetails(input.metadata);
      const freshnessSource = details?.freshnessSource;
      const freshnessReason = details?.freshnessReason;
      if (
        typeof freshnessSource !== "string"
        || freshnessSource.length === 0
        || typeof freshnessReason !== "string"
        || freshnessReason.length === 0
      ) {
        warnings.push(infoWarning(
          "freshness-reason-missing",
          `Independent live reserve output marked freshness as unverified without operator-facing reason metadata${adapterLabel}`,
        ));
      }
    }
  }

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
