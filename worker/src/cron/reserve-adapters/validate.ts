import type { ReserveSlice } from "@shared/types/core";
import { DEPENDENCY_TYPE_VALUES } from "@shared/types/dependency-types";
import {
  LIVE_RESERVE_REDEMPTION_CAPACITY_KIND_VALUES,
  LIVE_RESERVE_REDEMPTION_FRESHNESS_KIND_VALUES,
  LIVE_RESERVE_REDEMPTION_ROUTE_STATUS_SOURCE_VALUES,
  LIVE_RESERVE_REDEMPTION_ROUTE_STATUS_VALUES,
  type LiveReserveWarning,
} from "@shared/types/live-reserves";
import { RedemptionHolderEligibilitySchema } from "@shared/types/redemption";
import { isValidIsoDateOnly } from "@shared/types/date-primitives";
import type { ReserveAdapterDefinition } from "./types";
import { isReserveRisk, PCT_SUM_ERROR_TOLERANCE } from "./helpers";
import { reserveDegradedWarning, reserveFatalWarning, reserveInfoWarning } from "./warnings";

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
  maxSourceAgeSec?: number;
  subjectId?: string;
  knownStablecoinIds?: ReadonlySet<string>;
}

const PCT_SUM_WARNING_TOLERANCE = 0.5;
export const MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC = 10 * 60;

function getFiniteMetadataNumber(metadata: Record<string, unknown> | undefined, key: string): number | null {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

interface MetadataNumberField {
  value: number | null;
  invalid: boolean;
}

function getMetadataNumberField(metadata: Record<string, unknown> | undefined, key: string): MetadataNumberField {
  if (!metadata || !(key in metadata) || metadata[key] == null) {
    return { value: null, invalid: false };
  }
  const value = metadata[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { value: null, invalid: true };
  }
  return { value, invalid: false };
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

function hasInvalidNumber(values: readonly MetadataNumberField[]): boolean {
  return values.some((value) => value.invalid);
}

function hasOutOfRangeFeeBps(values: readonly (number | null)[]): boolean {
  return values.some((value) => value != null && (value < 0 || value > 10_000));
}

function isValidUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isValidReviewedAtDate(value: string): boolean {
  return isValidIsoDateOnly(value);
}

function isKnownValue<const T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === "string" && values.includes(value as T[number]);
}

function validateNonNegativeRedemptionNumber(
  redemption: Record<string, unknown>,
  key: string,
  code: string,
  label: string,
  adapterLabel: string,
): LiveReserveWarning | null {
  const value = redemption[key];
  if (value == null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return reserveFatalWarning(code, `${label} is invalid${adapterLabel}`);
  }
  return null;
}

function getMetadataDetails(metadata: Record<string, unknown> | undefined): Record<string, unknown> | null {
  const details = metadata?.details;
  return details && typeof details === "object" && !Array.isArray(details)
    ? (details as Record<string, unknown>)
    : null;
}

function getMetadataObject(metadata: Record<string, unknown> | undefined, key: string): Record<string, unknown> | null {
  const value = metadata?.[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
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

  return reserveFatalWarning(
    "future-source-timestamp",
    `${label} is ${value - now}s in the future${describeAdapter(adapter)} ` +
      `(max ${MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC}s)`,
  );
}

function validateRedemptionTelemetry(
  metadata: Record<string, unknown> | undefined,
  adapter: ReserveAdapterDefinition | undefined,
): LiveReserveWarning[] {
  const warnings: LiveReserveWarning[] = [];
  const adapterLabel = describeAdapter(adapter);
  const redemption = getMetadataObject(metadata, "redemption");
  const capacityUsdFields = [
    getMetadataNumberField(metadata, "immediateRedeemableUsd"),
    getMetadataNumberField(redemption ?? undefined, "capacityUsd"),
  ] as const;
  const capacityRatioFields = [
    getMetadataNumberField(metadata, "immediateRedeemableRatio"),
    getMetadataNumberField(redemption ?? undefined, "capacityRatioOfSupply"),
  ] as const;
  const feeBpsFields = [
    getMetadataNumberField(metadata, "redemptionFeeBps"),
    getMetadataNumberField(redemption ?? undefined, "feeBps"),
  ] as const;
  const capacityUsdValues = capacityUsdFields.map((field) => field.value);
  const capacityRatioValues = capacityRatioFields.map((field) => field.value);
  const feeBpsValues = feeBpsFields.map((field) => field.value);

  const hasCapacityTelemetry = hasNumber(capacityUsdValues) || hasNumber(capacityRatioValues);
  const hasFeeTelemetry = hasNumber(feeBpsValues);
  const adapterCapacity = adapter?.redemptionTelemetry?.capacity ?? "none";
  const adapterFee = adapter?.redemptionTelemetry?.fee ?? "none";

  if (hasInvalidNumber(capacityUsdFields) || hasNegativeNumber(capacityUsdValues)) {
    warnings.push(
      reserveFatalWarning("invalid-redemption-capacity-usd", `Redemption capacity is invalid${adapterLabel}`),
    );
  }
  if (hasInvalidNumber(capacityRatioFields) || hasOutOfRangeRatio(capacityRatioValues)) {
    warnings.push(
      reserveFatalWarning(
        "invalid-redemption-capacity-ratio",
        `Redemption capacity ratio is outside 0-1${adapterLabel}`,
      ),
    );
  }
  if (hasInvalidNumber(feeBpsFields) || hasOutOfRangeFeeBps(feeBpsValues)) {
    warnings.push(reserveFatalWarning("invalid-redemption-fee-bps", `Redemption fee bps is invalid${adapterLabel}`));
  }
  if (hasCapacityTelemetry && adapterCapacity === "none") {
    warnings.push(
      reserveFatalWarning(
        "unsupported-redemption-capacity-telemetry",
        `Adapter emitted redemption capacity despite declaring no capacity telemetry${adapterLabel}`,
      ),
    );
  }
  if (hasFeeTelemetry && adapterFee === "none") {
    warnings.push(
      reserveFatalWarning(
        "unsupported-redemption-fee-telemetry",
        `Adapter emitted redemption fee despite declaring no fee telemetry${adapterLabel}`,
      ),
    );
  }

  const capacityKind = redemption?.capacityKind;
  if (capacityKind != null && !isKnownValue(LIVE_RESERVE_REDEMPTION_CAPACITY_KIND_VALUES, capacityKind)) {
    warnings.push(
      reserveFatalWarning("invalid-redemption-capacity-kind", `Redemption capacity kind is invalid${adapterLabel}`),
    );
  } else if (capacityKind === "live-direct" || capacityKind === "live-direct-bounded") {
    if (adapterCapacity !== "direct") {
      warnings.push(
        reserveFatalWarning(
          "redemption-capacity-kind-mismatch",
          `Adapter emitted ${capacityKind} capacity without direct telemetry capability${adapterLabel}`,
        ),
      );
    }
  } else if (capacityKind === "live-proxy-validated" || capacityKind === "live-queue") {
    if (adapterCapacity !== "proxy") {
      warnings.push(
        reserveFatalWarning(
          "redemption-capacity-kind-mismatch",
          `Adapter emitted ${capacityKind} capacity without proxy telemetry capability${adapterLabel}`,
        ),
      );
    }
  }

  if (capacityKind === "live-queue") {
    const hasQueueSemantics =
      getFiniteMetadataNumber(redemption ?? undefined, "queueDepthUsd") != null ||
      getFiniteMetadataNumber(redemption ?? undefined, "settlementDelaySec") != null ||
      getFiniteMetadataNumber(redemption ?? undefined, "dailyLimitUsd") != null;
    if (!hasQueueSemantics) {
      warnings.push(
        reserveDegradedWarning(
          "redemption-queue-semantics-missing",
          `Queue redemption capacity omitted queue depth, settlement delay, or daily limit metadata${adapterLabel}`,
        ),
      );
    }
  }

  const freshnessKind = redemption?.freshnessKind;
  if (freshnessKind != null && !isKnownValue(LIVE_RESERVE_REDEMPTION_FRESHNESS_KIND_VALUES, freshnessKind)) {
    warnings.push(
      reserveFatalWarning("invalid-redemption-freshness-kind", `Redemption freshness kind is invalid${adapterLabel}`),
    );
  }
  const redemptionSourceTimestamp = getMetadataNumberField(redemption ?? undefined, "sourceTimestamp");
  if (
    redemptionSourceTimestamp.invalid ||
    (redemptionSourceTimestamp.value != null && redemptionSourceTimestamp.value < 0)
  ) {
    warnings.push(
      reserveFatalWarning(
        "invalid-redemption-source-timestamp",
        `Redemption source timestamp is invalid${adapterLabel}`,
      ),
    );
  }
  if (
    freshnessKind === "verified-source-timestamp" &&
    !redemptionSourceTimestamp.invalid &&
    redemptionSourceTimestamp.value == null
  ) {
    warnings.push(
      reserveFatalWarning(
        "missing-redemption-source-timestamp",
        `Redemption freshness is verified-source-timestamp without sourceTimestamp${adapterLabel}`,
      ),
    );
  }
  // Skip the redemption-capacity-unverified degrade when the adapter's policy
  // already restricts freshness to "unverified" only — in that case the output
  // is expected to be unverified and re-degrading on top of that policy would
  // double-count the same freshness concern.
  const allowedFreshnessModes = adapter?.validation?.allowedFreshnessModes;
  const freshnessPolicyIsUnverifiedOnly =
    Array.isArray(allowedFreshnessModes) &&
    allowedFreshnessModes.length === 1 &&
    allowedFreshnessModes[0] === "unverified";
  if (hasCapacityTelemetry && freshnessKind === "unverified" && !freshnessPolicyIsUnverifiedOnly) {
    warnings.push(
      reserveDegradedWarning(
        "redemption-capacity-unverified",
        `Redemption capacity telemetry is marked unverified${adapterLabel}`,
      ),
    );
  }

  const routeStatus = redemption?.routeStatus;
  const hasKnownRouteStatus = isKnownValue(LIVE_RESERVE_REDEMPTION_ROUTE_STATUS_VALUES, routeStatus);
  if (routeStatus != null && !hasKnownRouteStatus) {
    warnings.push(
      reserveFatalWarning("invalid-redemption-route-status", `Redemption route status is invalid${adapterLabel}`),
    );
  }

  const routeStatusSource = redemption?.routeStatusSource;
  const hasKnownRouteStatusSource = isKnownValue(LIVE_RESERVE_REDEMPTION_ROUTE_STATUS_SOURCE_VALUES, routeStatusSource);
  if (routeStatusSource != null && !hasKnownRouteStatusSource) {
    warnings.push(
      reserveFatalWarning(
        "invalid-redemption-route-status-source",
        `Redemption route status source is invalid${adapterLabel}`,
      ),
    );
  }
  if (hasKnownRouteStatus && routeStatus !== "unknown" && !hasKnownRouteStatusSource) {
    warnings.push(
      reserveFatalWarning(
        "missing-redemption-route-status-source",
        `Redemption route status requires source attribution${adapterLabel}`,
      ),
    );
  }

  const routeStatusReviewedAt = redemption?.routeStatusReviewedAt;
  if (routeStatusReviewedAt != null && typeof routeStatusReviewedAt !== "string") {
    warnings.push(
      reserveFatalWarning(
        "invalid-redemption-route-reviewed-at",
        `Redemption route status review timestamp is invalid${adapterLabel}`,
      ),
    );
  } else if (typeof routeStatusReviewedAt === "string" && !isValidReviewedAtDate(routeStatusReviewedAt)) {
    warnings.push(
      reserveFatalWarning(
        "invalid-redemption-route-reviewed-at",
        `Redemption route status review timestamp must be YYYY-MM-DD${adapterLabel}`,
      ),
    );
  }

  const holderEligibility = redemption?.holderEligibility;
  if (holderEligibility != null && !isKnownValue(RedemptionHolderEligibilitySchema.options, holderEligibility)) {
    warnings.push(
      reserveFatalWarning(
        "invalid-redemption-holder-eligibility",
        `Redemption holder eligibility is invalid${adapterLabel}`,
      ),
    );
  }

  for (const [key, code, label] of [
    ["settlementDelaySec", "invalid-redemption-settlement-delay", "Redemption settlement delay"],
    ["queueDepthUsd", "invalid-redemption-queue-depth", "Redemption queue depth"],
    ["dailyLimitUsd", "invalid-redemption-daily-limit", "Redemption daily limit"],
    ["minRedeemUsd", "invalid-redemption-min-redeem", "Redemption minimum redeem amount"],
  ] as const) {
    const warning = validateNonNegativeRedemptionNumber(redemption ?? {}, key, code, label, adapterLabel);
    if (warning) {
      warnings.push(warning);
    }
  }

  const sourceUrls = redemption?.sourceUrls;
  if (sourceUrls != null) {
    if (!Array.isArray(sourceUrls) || sourceUrls.some((url) => typeof url !== "string" || !isValidUrl(url))) {
      warnings.push(
        reserveFatalWarning("invalid-redemption-source-urls", `Redemption source URLs are invalid${adapterLabel}`),
      );
    }
  }

  return warnings;
}

export function validateAdapterOutput(input: ValidationInput, options?: ValidationOptions): ValidationResult {
  if (input.slices.length === 0) {
    return { valid: false, warnings: [reserveFatalWarning("empty-slices", "Adapter returned zero reserve slices")] };
  }

  const warnings: LiveReserveWarning[] = [];
  const now = options?.now ?? Math.floor(Date.now() / 1000);
  const sourceTimestamp = getFiniteMetadataNumber(input.metadata, "sourceTimestamp");
  const redemption = getMetadataObject(input.metadata, "redemption");
  const redemptionSourceTimestamp = getFiniteMetadataNumber(redemption ?? undefined, "sourceTimestamp");
  const futureTimestampWarning =
    validateFutureTimestamp(sourceTimestamp, "Upstream reserve source timestamp", now, options?.adapter) ??
    validateFutureTimestamp(redemptionSourceTimestamp, "Redemption source timestamp", now, options?.adapter);
  if (futureTimestampWarning) {
    return { valid: false, warnings: [futureTimestampWarning] };
  }

  const redemptionWarnings = validateRedemptionTelemetry(input.metadata, options?.adapter);
  if (hasFatalWarnings(redemptionWarnings)) {
    return { valid: false, warnings: redemptionWarnings };
  }
  warnings.push(...redemptionWarnings);

  for (const slice of input.slices) {
    if (typeof slice.name !== "string" || slice.name.trim().length === 0) {
      return {
        valid: false,
        warnings: [reserveFatalWarning("invalid-name", "Reserve slice has an empty name")],
      };
    }
    if (!Number.isFinite(slice.pct) || slice.pct <= 0) {
      return {
        valid: false,
        warnings: [reserveFatalWarning("invalid-pct", `Slice "${slice.name}" has invalid pct: ${slice.pct}`)],
      };
    }
    if (slice.pct > 100) {
      return {
        valid: false,
        warnings: [reserveFatalWarning("invalid-pct", `Slice "${slice.name}" has pct above 100: ${slice.pct}`)],
      };
    }
    if (!isReserveRisk(slice.risk)) {
      return {
        valid: false,
        warnings: [reserveFatalWarning("invalid-risk", `Slice "${slice.name}" has invalid risk: ${slice.risk}`)],
      };
    }
    if (slice.depType != null && !DEPENDENCY_TYPE_VALUES.includes(slice.depType)) {
      return {
        valid: false,
        warnings: [reserveFatalWarning("invalid-dependency-type", `Slice "${slice.name}" has invalid depType`)],
      };
    }
    if (slice.depType != null && !slice.coinId) {
      return {
        valid: false,
        warnings: [
          reserveFatalWarning("dependency-type-without-target", `Slice "${slice.name}" has depType without coinId`),
        ],
      };
    }
    if (slice.coinId != null && (typeof slice.coinId !== "string" || slice.coinId.trim().length === 0)) {
      return {
        valid: false,
        warnings: [reserveFatalWarning("invalid-dependency-target", `Slice "${slice.name}" has invalid coinId`)],
      };
    }
    if (slice.coinId != null && slice.coinId === options?.subjectId) {
      return {
        valid: false,
        warnings: [reserveFatalWarning("self-dependency", `Slice "${slice.name}" links ${slice.coinId} to itself`)],
      };
    }
    if (slice.coinId != null && options?.knownStablecoinIds && !options.knownStablecoinIds.has(slice.coinId)) {
      return {
        valid: false,
        warnings: [
          reserveFatalWarning(
            "unknown-dependency-target",
            `Slice "${slice.name}" links unknown stablecoin ${slice.coinId}`,
          ),
        ],
      };
    }
  }

  const sum = input.slices.reduce((s, r) => s + r.pct, 0);
  const deviation = Math.abs(sum - 100);
  const adapterLabel = describeAdapter(options?.adapter);
  if (deviation > PCT_SUM_ERROR_TOLERANCE) {
    return {
      valid: false,
      warnings: [
        reserveFatalWarning(
          "pct-sum-deviation",
          `Slice percentages sum to ${sum.toFixed(1)}%${adapterLabel} (expected 100% ± ${PCT_SUM_ERROR_TOLERANCE}%)`,
        ),
      ],
    };
  }
  if (deviation > PCT_SUM_WARNING_TOLERANCE) {
    warnings.push(
      reserveDegradedWarning(
        "pct-sum-deviation",
        `Slice percentages sum to ${sum.toFixed(1)}%${adapterLabel} (expected 100% ± ${PCT_SUM_WARNING_TOLERANCE}%)`,
      ),
    );
  }

  const maxSourceAgeSec = options?.maxSourceAgeSec ?? options?.adapter?.validation?.maxSourceAgeSec;
  if (maxSourceAgeSec != null && sourceTimestamp != null) {
    const ageSec = now - sourceTimestamp;
    if (ageSec > maxSourceAgeSec) {
      warnings.push(
        reserveDegradedWarning(
          "stale-source-data",
          `Upstream reserve source timestamp is ${ageSec}s old${adapterLabel} (max ${maxSourceAgeSec}s)`,
        ),
      );
    }
  }

  const maxUnknownExposurePct = options?.adapter?.validation?.maxUnknownExposurePct;
  const unknownExposurePct = getFiniteMetadataNumber(input.metadata, "unknownExposurePct");
  if (maxUnknownExposurePct != null && unknownExposurePct != null && unknownExposurePct > maxUnknownExposurePct) {
    warnings.push(
      reserveDegradedWarning(
        "material-unknown-exposure",
        `Unknown reserve exposure is ${unknownExposurePct.toFixed(2)}%${adapterLabel} ` +
          `(max ${maxUnknownExposurePct.toFixed(2)}%)`,
      ),
    );
  }

  const freshnessMode = input.metadata?.freshnessMode;
  const allowedFreshnessModes = options?.adapter?.validation?.allowedFreshnessModes;
  if (
    Array.isArray(allowedFreshnessModes) &&
    allowedFreshnessModes.length > 0 &&
    typeof freshnessMode === "string" &&
    !allowedFreshnessModes.includes(freshnessMode as (typeof allowedFreshnessModes)[number])
  ) {
    warnings.push(
      reserveDegradedWarning(
        "freshness-mode-disallowed",
        `Live reserve output emitted freshnessMode=${freshnessMode}${adapterLabel}, allowed modes: ${allowedFreshnessModes.join(", ")}`,
      ),
    );
  }

  if (options?.adapter?.evidenceClass === "independent") {
    if (freshnessMode === "verified" && sourceTimestamp == null) {
      return {
        valid: false,
        warnings: [
          reserveFatalWarning(
            "verified-freshness-missing-source-timestamp",
            `Independent live reserve output marked freshness as verified without sourceTimestamp${adapterLabel}`,
          ),
        ],
      };
    }

    if (sourceTimestamp != null && freshnessMode == null) {
      warnings.push(
        reserveDegradedWarning(
          "freshness-mode-missing",
          `Independent live reserve output is missing freshnessMode despite providing sourceTimestamp${adapterLabel}`,
        ),
      );
    }

    if (sourceTimestamp == null && freshnessMode == null) {
      warnings.push(
        reserveDegradedWarning(
          "freshness-metadata-missing",
          `Independent live reserve output omitted explicit freshness metadata${adapterLabel}`,
        ),
      );
    }

    if (freshnessMode === "unverified") {
      const details = getMetadataDetails(input.metadata);
      const freshnessSource = details?.freshnessSource;
      const freshnessReason = details?.freshnessReason;
      if (
        typeof freshnessSource !== "string" ||
        freshnessSource.length === 0 ||
        typeof freshnessReason !== "string" ||
        freshnessReason.length === 0
      ) {
        warnings.push(
          reserveInfoWarning(
            "freshness-reason-missing",
            `Independent live reserve output marked freshness as unverified without operator-facing reason metadata${adapterLabel}`,
          ),
        );
      }
    }
  }

  if (maxSourceAgeSec != null && sourceTimestamp == null && freshnessMode === "unverified") {
    warnings.push(
      reserveInfoWarning(
        "freshness-unverified",
        `Upstream reserve source timestamp is unavailable${adapterLabel}; freshness remains unverified`,
      ),
    );
  }

  return { valid: true, warnings };
}

export function hasDegradingWarnings(warnings: readonly LiveReserveWarning[] | undefined): boolean {
  return (warnings ?? []).some((warning) => warning.effect === "degraded");
}

export function hasFatalWarnings(warnings: readonly LiveReserveWarning[] | undefined): boolean {
  return (warnings ?? []).some((warning) => warning.effect === "fatal");
}
