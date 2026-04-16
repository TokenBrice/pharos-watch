import type { ReserveSlice } from "@shared/types/core";
import {
  LIVE_RESERVE_REDEMPTION_ROUTE_STATUS_SOURCE_VALUES,
  LIVE_RESERVE_REDEMPTION_ROUTE_STATUS_VALUES,
  type LiveReserveWarning,
} from "@shared/types/live-reserves";
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
export const MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC = 10 * 60;

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

function hasNegativeNumber(values: readonly (number | null)[]): boolean {
  return values.some((value) => value != null && value < 0);
}

function hasOutOfRangeRatio(values: readonly (number | null)[]): boolean {
  return values.some((value) => value != null && (value < 0 || value > 1));
}

function hasNumber(values: readonly (number | null)[]): boolean {
  return values.some((value) => value != null);
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

function validateFutureTimestamp(
  value: number | null,
  label: string,
  now: number,
  adapter: ReserveAdapterDefinition | undefined,
): LiveReserveWarning | null {
  if (value == null || value <= now + MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC) {
    return null;
  }

  return fatalWarning(
    "future-source-timestamp",
    `${label} is ${value - now}s in the future${describeAdapter(adapter)} `
    + `(max ${MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC}s)`,
  );
}

function validateRedemptionTelemetry(
  metadata: Record<string, unknown> | undefined,
  adapter: ReserveAdapterDefinition | undefined,
): LiveReserveWarning[] {
  const warnings: LiveReserveWarning[] = [];
  const adapterLabel = describeAdapter(adapter);
  const redemption = getMetadataObject(metadata, "redemption");
  const capacityUsdValues = [
    getFiniteMetadataNumber(metadata, "immediateRedeemableUsd"),
    getFiniteMetadataNumber(redemption ?? undefined, "capacityUsd"),
  ] as const;
  const capacityRatioValues = [
    getFiniteMetadataNumber(metadata, "immediateRedeemableRatio"),
    getFiniteMetadataNumber(redemption ?? undefined, "capacityRatioOfSupply"),
  ] as const;
  const feeBpsValues = [
    getFiniteMetadataNumber(metadata, "redemptionFeeBps"),
    getFiniteMetadataNumber(redemption ?? undefined, "feeBps"),
  ] as const;

  const hasCapacityTelemetry = hasNumber(capacityUsdValues) || hasNumber(capacityRatioValues);
  const hasFeeTelemetry = hasNumber(feeBpsValues);
  const adapterCapacity = adapter?.redemptionTelemetry?.capacity ?? "none";
  const adapterFee = adapter?.redemptionTelemetry?.fee ?? "none";

  if (hasNegativeNumber(capacityUsdValues)) {
    warnings.push(fatalWarning("invalid-redemption-capacity-usd", `Redemption capacity is negative${adapterLabel}`));
  }
  if (hasOutOfRangeRatio(capacityRatioValues)) {
    warnings.push(fatalWarning("invalid-redemption-capacity-ratio", `Redemption capacity ratio is outside 0-1${adapterLabel}`));
  }
  if (hasNegativeNumber(feeBpsValues)) {
    warnings.push(fatalWarning("invalid-redemption-fee-bps", `Redemption fee bps is negative${adapterLabel}`));
  }
  if (hasCapacityTelemetry && adapterCapacity === "none") {
    warnings.push(fatalWarning("unsupported-redemption-capacity-telemetry", `Adapter emitted redemption capacity despite declaring no capacity telemetry${adapterLabel}`));
  }
  if (hasFeeTelemetry && adapterFee === "none") {
    warnings.push(fatalWarning("unsupported-redemption-fee-telemetry", `Adapter emitted redemption fee despite declaring no fee telemetry${adapterLabel}`));
  }

  const capacityKind = redemption?.capacityKind;
  if (
    typeof capacityKind === "string" &&
    (capacityKind === "live-direct" || capacityKind === "live-direct-bounded") &&
    adapterCapacity !== "direct"
  ) {
    warnings.push(fatalWarning("redemption-capacity-kind-mismatch", `Adapter emitted ${capacityKind} capacity without direct telemetry capability${adapterLabel}`));
  }

  const freshnessKind = redemption?.freshnessKind;
  // Skip the redemption-capacity-unverified degrade when the adapter's policy
  // already restricts freshness to "unverified" only — in that case the output
  // is expected to be unverified and re-degrading on top of that policy would
  // double-count the same freshness concern.
  const allowedFreshnessModes = adapter?.validation?.allowedFreshnessModes;
  const freshnessPolicyIsUnverifiedOnly =
    Array.isArray(allowedFreshnessModes)
    && allowedFreshnessModes.length === 1
    && allowedFreshnessModes[0] === "unverified";
  if (
    hasCapacityTelemetry
    && freshnessKind === "unverified"
    && !freshnessPolicyIsUnverifiedOnly
  ) {
    warnings.push(degradedWarning(
      "redemption-capacity-unverified",
      `Redemption capacity telemetry is marked unverified${adapterLabel}`,
    ));
  }

  const routeStatus = redemption?.routeStatus;
  if (
    typeof routeStatus === "string" &&
    !LIVE_RESERVE_REDEMPTION_ROUTE_STATUS_VALUES.includes(
      routeStatus as (typeof LIVE_RESERVE_REDEMPTION_ROUTE_STATUS_VALUES)[number],
    )
  ) {
    warnings.push(fatalWarning("invalid-redemption-route-status", `Redemption route status is invalid${adapterLabel}`));
  }

  const routeStatusSource = redemption?.routeStatusSource;
  if (
    typeof routeStatusSource === "string" &&
    !LIVE_RESERVE_REDEMPTION_ROUTE_STATUS_SOURCE_VALUES.includes(
      routeStatusSource as (typeof LIVE_RESERVE_REDEMPTION_ROUTE_STATUS_SOURCE_VALUES)[number],
    )
  ) {
    warnings.push(fatalWarning("invalid-redemption-route-status-source", `Redemption route status source is invalid${adapterLabel}`));
  }

  const routeStatusReviewedAt = redemption?.routeStatusReviewedAt;
  if (routeStatusReviewedAt != null && typeof routeStatusReviewedAt !== "string") {
    warnings.push(fatalWarning("invalid-redemption-route-reviewed-at", `Redemption route status review timestamp is invalid${adapterLabel}`));
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
  const now = options?.now ?? Math.floor(Date.now() / 1000);
  const sourceTimestamp = getFiniteMetadataNumber(input.metadata, "sourceTimestamp");
  const redemption = getMetadataObject(input.metadata, "redemption");
  const redemptionSourceTimestamp = getFiniteMetadataNumber(redemption ?? undefined, "sourceTimestamp");
  const futureTimestampWarning =
    validateFutureTimestamp(sourceTimestamp, "Upstream reserve source timestamp", now, options?.adapter)
    ?? validateFutureTimestamp(redemptionSourceTimestamp, "Redemption source timestamp", now, options?.adapter);
  if (futureTimestampWarning) {
    return { valid: false, warnings: [futureTimestampWarning] };
  }

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

  const maxSourceAgeSec = options?.adapter?.validation?.maxSourceAgeSec;
  if (maxSourceAgeSec != null && sourceTimestamp != null) {
    const ageSec = now - sourceTimestamp;
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
