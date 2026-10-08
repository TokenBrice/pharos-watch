import type { ReserveSlice } from "@shared/types/core";
import { ReserveSliceSchema } from "@shared/types/reserves";
import { DEPENDENCY_TYPE_VALUES } from "@shared/types/dependency-types";
import {
  decodeLiveReserveRedemptionTelemetry,
  LiveReserveDiagnosticsSchema,
  type LiveReserveWarning,
} from "@shared/types/live-reserves";
import type { ReserveAdapterDefinition } from "./types";
import { isReserveRisk, PCT_SUM_ERROR_TOLERANCE } from "./helpers";
import { reserveDegradedWarning, reserveFatalWarning, reserveInfoWarning } from "./warnings";
import { LIVE_RESERVE_FRESHNESS_SEC } from "../../lib/live-reserves/store-shared";
import { MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC, resolveLiveReserveSourceAgeBudget } from "@shared/lib/live-reserve-freshness";

export interface ValidationInput {
  slices: ReserveSlice[];
  metadata?: Record<string, unknown>;
}

export interface ValidationResult {
  valid: boolean;
  warnings: LiveReserveWarning[];
}

export interface ValidationOptions {
  adapter?: ReserveAdapterDefinition;
  now?: number;
  maxSourceAgeSec?: number;
  subjectId?: string;
  knownStablecoinIds?: ReadonlySet<string>;
}

const PCT_SUM_WARNING_TOLERANCE = 0.5;

// Diagnostic vocabulary only: structural constraints live exclusively in the schema.
const REDEMPTION_ISSUE_CODES: Readonly<Record<string, string>> = {
  capacityUsd: "invalid-redemption-capacity-usd",
  capacityRatioOfSupply: "invalid-redemption-capacity-ratio",
  feeBps: "invalid-redemption-fee-bps",
  capacityKind: "invalid-redemption-capacity-kind",
  freshnessKind: "invalid-redemption-freshness-kind",
  sourceTimestamp: "invalid-redemption-source-timestamp",
  routeStatus: "invalid-redemption-route-status",
  routeStatusSource: "invalid-redemption-route-status-source",
  routeStatusReviewedAt: "invalid-redemption-route-reviewed-at",
  holderEligibility: "invalid-redemption-holder-eligibility",
  settlementDelaySec: "invalid-redemption-settlement-delay",
  queueDepthUsd: "invalid-redemption-queue-depth",
  dailyLimitUsd: "invalid-redemption-daily-limit",
  minRedeemUsd: "invalid-redemption-min-redeem",
  sourceUrls: "invalid-redemption-source-urls",
  outputAssetKeys: "invalid-redemption-output-assets",
  outputValuation: "invalid-redemption-output-valuation",
};

function getFiniteMetadataNumber(metadata: Record<string, unknown> | undefined, key: string): number | null {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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
function freshnessPolicyIsUnverifiedOnly(adapter: ReserveAdapterDefinition | undefined): boolean {
  const allowedFreshnessModes = adapter?.validation?.allowedFreshnessModes;
  return (
    Array.isArray(allowedFreshnessModes) &&
    allowedFreshnessModes.length === 1 &&
    allowedFreshnessModes[0] === "unverified"
  );
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
  const decoded = decodeLiveReserveRedemptionTelemetry(metadata);
  if (decoded.status === "absent") return [];
  const adapterLabel = describeAdapter(adapter);
  if (decoded.status === "invalid") {
    const warnings: LiveReserveWarning[] = [];
    for (const issue of decoded.issues) {
      const field = String(issue.path[0] ?? "");
      const code = REDEMPTION_ISSUE_CODES[field] ?? "invalid-redemption-telemetry";
      if (!warnings.some((warning) => warning.code === code)) {
        warnings.push(reserveFatalWarning(code, `Redemption ${field || "telemetry"} is invalid${adapterLabel}`));
      }
    }
    return warnings;
  }
  const redemption = decoded.telemetry;
  const warnings: LiveReserveWarning[] = [];
  const hasCapacityTelemetry = redemption.capacityUsd != null || redemption.capacityRatioOfSupply != null;
  const hasFeeTelemetry = redemption.feeBps != null;
  const adapterCapacity = adapter?.redemptionTelemetry?.capacity ?? "none";
  const adapterFee = adapter?.redemptionTelemetry?.fee ?? "none";
  if (hasCapacityTelemetry && adapterCapacity === "none") {
    warnings.push(reserveFatalWarning("unsupported-redemption-capacity-telemetry",
      `Adapter emitted redemption capacity despite declaring no capacity telemetry${adapterLabel}`));
  }
  if (hasFeeTelemetry && adapterFee === "none") {
    warnings.push(reserveFatalWarning("unsupported-redemption-fee-telemetry",
      `Adapter emitted redemption fee despite declaring no fee telemetry${adapterLabel}`));
  }
  const capacityKind = redemption.capacityKind;
  if ((capacityKind === "live-direct" || capacityKind === "live-direct-bounded") && adapterCapacity !== "direct") {
    warnings.push(reserveFatalWarning("redemption-capacity-kind-mismatch",
      `Adapter emitted ${capacityKind} capacity without direct telemetry capability${adapterLabel}`));
  } else if ((capacityKind === "live-proxy-validated" || capacityKind === "live-queue") && adapterCapacity !== "proxy") {
    warnings.push(reserveFatalWarning("redemption-capacity-kind-mismatch",
      `Adapter emitted ${capacityKind} capacity without proxy telemetry capability${adapterLabel}`));
  }
  if (capacityKind === "live-queue" && redemption.queueDepthUsd == null &&
    redemption.settlementDelaySec == null && redemption.dailyLimitUsd == null) {
    warnings.push(reserveDegradedWarning("redemption-queue-semantics-missing",
      `Queue redemption capacity omitted queue depth, settlement delay, or daily limit metadata${adapterLabel}`));
  }
  if (redemption.freshnessKind === "verified-source-timestamp" && redemption.sourceTimestamp == null) {
    warnings.push(reserveFatalWarning("missing-redemption-source-timestamp",
      `Redemption freshness is verified-source-timestamp without sourceTimestamp${adapterLabel}`));
  }
  if (hasCapacityTelemetry && redemption.freshnessKind === "unverified" && !freshnessPolicyIsUnverifiedOnly(adapter)) {
    warnings.push(reserveDegradedWarning("redemption-capacity-unverified",
      `Redemption capacity telemetry is marked unverified${adapterLabel}`));
  }
  if (redemption.routeStatus != null && redemption.routeStatus !== "unknown" && redemption.routeStatusSource == null) {
    warnings.push(reserveFatalWarning("missing-redemption-route-status-source",
      `Redemption route status requires source attribution${adapterLabel}`));
  }
  return warnings;
}

export function validateAdapterOutput(input: ValidationInput, options?: ValidationOptions): ValidationResult {
  if (input.slices.length === 0) {
    return { valid: false, warnings: [reserveFatalWarning("empty-slices", "Adapter returned zero reserve slices")] };
  }

  const warnings: LiveReserveWarning[] = [];
  const now = options?.now ?? Math.floor(Date.now() / 1000);
  const observedBlock = getMetadataObject(input.metadata, "observedBlock");
  const blockTimestamp = getFiniteMetadataNumber(observedBlock ?? undefined, "timestamp");
  if (blockTimestamp != null && now - blockTimestamp > 10 * 60) {
    warnings.push(reserveInfoWarning(
      "observed-block-lag",
      `Observed block is ${now - blockTimestamp}s older than the reserve attempt`,
    ));
  }
  const sourceTimestamp = getFiniteMetadataNumber(input.metadata, "sourceTimestamp");
  const redemption = getMetadataObject(input.metadata, "redemption");
  const redemptionSourceTimestamp = getFiniteMetadataNumber(redemption ?? undefined, "sourceTimestamp");
  const futureTimestampWarning =
    validateFutureTimestamp(sourceTimestamp, "Upstream reserve source timestamp", now, options?.adapter) ??
    validateFutureTimestamp(getFiniteMetadataNumber(input.metadata, "newestSourceTimestamp"), "Newest reserve component timestamp", now, options?.adapter) ??
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

  for (const slice of input.slices) {
    if (!ReserveSliceSchema.safeParse(slice).success) {
      return {
        valid: false,
        warnings: [reserveFatalWarning("invalid-slice-schema", "Reserve slice violates the persisted snapshot schema")],
      };
    }
  }

  const sum = input.slices.reduce((s, r) => s + r.pct, 0);
  const finalDeviation = Math.abs(sum - 100);
  const diagnostics = getMetadataObject(input.metadata, "diag");
  const diagnosticsParsed = LiveReserveDiagnosticsSchema.safeParse(input.metadata?.diag);
  const rawDeviationParsed = diagnostics && Object.prototype.hasOwnProperty.call(diagnostics, "rawSumDeviation")
    ? LiveReserveDiagnosticsSchema.shape.rawSumDeviation.unwrap().safeParse(diagnostics.rawSumDeviation)
    : null;
  if ((input.metadata && Object.prototype.hasOwnProperty.call(input.metadata, "diag") && !diagnosticsParsed.success) ||
    (rawDeviationParsed && !rawDeviationParsed.success)) {
    return { valid: false, warnings: [reserveFatalWarning("invalid-raw-sum-deviation", "Upstream percentage diagnostics are malformed")] };
  }
  const rawDeviation = rawDeviationParsed?.success ? rawDeviationParsed.data : undefined;
  const deviation = rawDeviation == null ? finalDeviation : Math.max(finalDeviation, rawDeviation);
  const adapterLabel = describeAdapter(options?.adapter);
  const sumDescription = rawDeviation != null && rawDeviation > finalDeviation
    ? `Upstream slice percentages deviate from 100% by ${rawDeviation.toFixed(2)} percentage points before normalization`
    : `Slice percentages sum to ${sum.toFixed(1)}%`;
  if (deviation > PCT_SUM_ERROR_TOLERANCE) {
    return {
      valid: false,
      warnings: [
        reserveFatalWarning(
          "pct-sum-deviation",
          `${sumDescription}${adapterLabel} (expected 100% ± ${PCT_SUM_ERROR_TOLERANCE}%)`,
        ),
      ],
    };
  }
  if (deviation > PCT_SUM_WARNING_TOLERANCE) {
    warnings.push(
      reserveDegradedWarning(
        "pct-sum-deviation",
        `${sumDescription}${adapterLabel} (expected 100% ± ${PCT_SUM_WARNING_TOLERANCE}%)`,
      ),
    );
  }

  const sourceBudget = resolveLiveReserveSourceAgeBudget(
    options?.maxSourceAgeSec, options?.adapter?.validation?.maxSourceAgeSec, LIVE_RESERVE_FRESHNESS_SEC,
  );
  const maxSourceAgeSec = sourceBudget.sourceAgeBudgetCap === "fetch-budget" ? undefined : sourceBudget.sourceAgeBudgetSec;
  const nestedSourceBudget = sourceBudget.sourceAgeBudgetSec;
  const nestedSourceTimestamp = getFiniteMetadataNumber(
    getMetadataObject(input.metadata, "redemption") ?? undefined,
    "sourceTimestamp",
  );
  if (nestedSourceTimestamp != null && now - nestedSourceTimestamp > nestedSourceBudget) {
    return {
      valid: false,
      warnings: [
        ...warnings,
        reserveFatalWarning(
          "stale-redemption-source-timestamp",
          `Redemption source timestamp is ${now - nestedSourceTimestamp}s old${adapterLabel} (max ${nestedSourceBudget}s)`,
        ),
      ],
    };
  }
  const policyIsUnverifiedOnly = freshnessPolicyIsUnverifiedOnly(options?.adapter);
  const freshnessMode = input.metadata?.freshnessMode;
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
  } else if (maxSourceAgeSec != null && !policyIsUnverifiedOnly && freshnessMode !== "not-applicable") {
    warnings.push(
      reserveDegradedWarning(
        "stale-source-undeterminable",
        `Upstream reserve source timestamp is unavailable${adapterLabel}; declared source-age policy cannot be evaluated`,
      ),
    );
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

  if (
    maxSourceAgeSec != null &&
    sourceTimestamp == null &&
    freshnessMode === "unverified" &&
    policyIsUnverifiedOnly
  ) {
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
