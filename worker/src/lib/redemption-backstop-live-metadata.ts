import { getLiveReserveAdapterDefinition } from "@shared/lib/live-reserve-adapters";
import {
  getAllowedRedemptionCapacityWarningReason,
  isRedemptionFreshnessAllowedByPolicy,
} from "@shared/lib/redemption-backstop-configs/policies";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type {
  RedemptionCapacityConfidence,
  RedemptionHolderEligibility,
  RedemptionLiveCapacityKind,
  RedemptionLiveFreshnessKind,
  RedemptionRouteStatus,
  RedemptionRouteStatusSource,
} from "@shared/types/redemption";
import { LiveReserveRedemptionOutputValuationSchema } from "@shared/types/live-reserves";
import {
  RedemptionHolderEligibilitySchema,
  RedemptionLiveCapacityKindSchema,
  RedemptionLiveFreshnessKindSchema,
} from "@shared/types/redemption";
import type { LiveReserveRedemptionOutputValuation, LiveReserveWarning } from "@shared/types/live-reserves";
import {
  hasScoringEligibleLiveReserveFreshness,
  LIVE_RESERVE_FRESHNESS_SEC,
  SCORING_LIVE_RESERVE_EVIDENCE_CLASSES,
  type ReserveSnapshotMetadataRecord,
} from "./live-reserves-store";
import {
  parseAcceptedFpiControllerV9RouteState,
  type FpiControllerV9RouteState,
} from "./fpi-controller-redemption-route";
import {
  parseAcceptedSfrxusdCrosschainV9RouteState,
  type SfrxusdCrosschainV9RouteState,
} from "./sfrxusd-crosschain-redemption-route";
import { MALFORMED_REDEMPTION_TELEMETRY } from "./live-reserves-store-row-decoding";

export interface RedemptionBackstopLiveMetadata {
  updatedAt: number | null;
  isFresh: boolean;
  hasScoringEligibleFreshness: boolean;
  hasBlockingWarnings: boolean;
  capacityNotes: string[];
  capacityConfidence: Exclude<RedemptionCapacityConfidence, "documented-bound" | "heuristic"> | null;
  canUseCapacity: boolean;
  canUseFee: boolean;
  capacityReason: string | null;
  feeReason: string | null;
  immediateRedeemableUsd: number | null;
  immediateRedeemableRatio: number | null;
  settlementBoundUnproven: boolean;
  capacityKind: RedemptionLiveCapacityKind | null;
  freshnessKind: RedemptionLiveFreshnessKind | null;
  sourceTimestamp: number | null;
  sourceUrls: string[];
  settlementDelaySec: number | null;
  queueDepthUsd: number | null;
  dailyLimitUsd: number | null;
  minRedeemUsd: number | null;
  liveHolderEligibility: RedemptionHolderEligibility | null;
  redemptionFeeBps: number | null;
  buyFeeBpsMin: number | null;
  buyFeeBpsMax: number | null;
  routeStatus: RedemptionRouteStatus | null;
  routeStatusSource: RedemptionRouteStatusSource | null;
  routeStatusReason: string | null;
  routeStatusReviewedAt: string | null;
  v9FpiControllerRouteState: FpiControllerV9RouteState | null;
  v9SfrxusdCrosschainRouteState: SfrxusdCrosschainV9RouteState | null;
  v9OutputValuation?: LiveReserveRedemptionOutputValuation | null;
}

interface ParsedRedemptionTelemetry {
  fields: Record<string, unknown>;
  malformed: boolean;
}

function isMalformedRedemptionTelemetryMarker(raw: Record<string, unknown>): boolean {
  return (raw as { [MALFORMED_REDEMPTION_TELEMETRY]?: boolean })[MALFORMED_REDEMPTION_TELEMETRY] === true;
}

function getRedemptionTelemetry(metadata: Record<string, unknown>): ParsedRedemptionTelemetry {
  if (!Object.prototype.hasOwnProperty.call(metadata, "redemption")) {
    return { fields: {}, malformed: false };
  }
  const raw = metadata.redemption;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const fields = raw as Record<string, unknown>;
    return isMalformedRedemptionTelemetryMarker(fields)
      ? { fields: {}, malformed: true }
      : { fields, malformed: false };
  }
  return { fields: {}, malformed: true };
}

interface ParsedTelemetryNumber {
  value: number | null;
  invalid: boolean;
  warning?: string;
}

function parseTelemetryNumber(
  source: Record<string, unknown>,
  key: string,
  label: string,
  bounds: { min?: number; max?: number } = {},
): ParsedTelemetryNumber {
  if (!(key in source) || source[key] == null) return { value: null, invalid: false };
  const raw = source[key];
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return {
      value: null,
      invalid: true,
      warning: `${label} is malformed and was ignored`,
    };
  }
  if (bounds.min != null && raw < bounds.min) {
    return {
      value: null,
      invalid: true,
      warning: `${label} is below ${bounds.min} and was ignored`,
    };
  }
  if (bounds.max != null && raw > bounds.max) {
    return {
      value: null,
      invalid: true,
      warning: `${label} is above ${bounds.max} and was ignored`,
    };
  }
  return { value: raw, invalid: false };
}

function collectTelemetryWarnings(values: readonly ParsedTelemetryNumber[]): string[] {
  return values.flatMap((value) => (value.warning ? [value.warning] : []));
}

function hasTelemetryValue(value: ParsedTelemetryNumber): boolean {
  return value.value != null || value.invalid;
}

function coerceRouteStatus(value: unknown): RedemptionRouteStatus | null {
  return value === "open" ||
    value === "degraded" ||
    value === "paused" ||
    value === "cohort-limited" ||
    value === "unknown"
    ? value
    : null;
}

function coerceRouteStatusSource(value: unknown): RedemptionRouteStatusSource | null {
  return value === "static-config" ||
    value === "market-implied" ||
    value === "operator-notice" ||
    value === "protocol-api" ||
    value === "onchain"
    ? value
    : null;
}

function coerceString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function coerceReviewedAtDate(value: unknown): string | null {
  const date = coerceString(value);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : null;
}

function coerceUrlArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    try {
      const parsed = new URL(item);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
      const normalizedUrl = parsed.toString();
      if (seen.has(normalizedUrl)) continue;
      seen.add(normalizedUrl);
      urls.push(normalizedUrl);
    } catch {
      continue;
    }
  }
  return urls;
}

function coerceSchemaValue<T>(
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
  value: unknown,
): T | null {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const SCOREABLE_REDEMPTION_CAPACITY_KINDS = new Set<RedemptionLiveCapacityKind>([
  "live-direct",
  "live-direct-bounded",
  "live-queue",
  "live-proxy-validated",
  "documented-bound",
]);
const SCOREABLE_NESTED_REDEMPTION_FRESHNESS_KINDS = new Set<RedemptionLiveFreshnessKind>([
  "verified-source-timestamp",
  "same-run-onchain",
  "same-run-api",
]);
const MAX_FUTURE_REDEMPTION_SOURCE_TIMESTAMP_SKEW_SEC = 10 * 60;

function hasScoreableNestedRedemptionEvidence(
  capacityKind: RedemptionLiveCapacityKind | null,
  freshnessKind: RedemptionLiveFreshnessKind | null,
): boolean {
  return (
    capacityKind != null &&
    SCOREABLE_REDEMPTION_CAPACITY_KINDS.has(capacityKind) &&
    freshnessKind != null &&
    SCOREABLE_NESTED_REDEMPTION_FRESHNESS_KINDS.has(freshnessKind)
  );
}

function isRedemptionFreshnessAllowed(
  stablecoinId: string,
  freshnessKind: RedemptionLiveFreshnessKind | null,
  hasScoringEligibleFreshness: boolean,
): boolean {
  return isRedemptionFreshnessAllowedByPolicy({ stablecoinId, freshnessKind, hasScoringEligibleFreshness });
}

function hasBlockingRedemptionWarnings(
  stablecoinId: string,
  warnings: LiveReserveWarning[],
  warningCount: number,
): boolean {
  if (warningCount <= 0) return false;
  if (warnings.length === 0) return true;
  return warnings.some(
    (warning) => warning.effect !== "info" && !getAllowedRedemptionCapacityWarningReason(stablecoinId, warning),
  );
}

function canUseCapacityDespiteDegradedSync(
  stablecoinId: string,
  snapshotMetadata: ReserveSnapshotMetadataRecord | null | undefined,
): boolean {
  if (!snapshotMetadata || snapshotMetadata.syncStatus !== "degraded" || snapshotMetadata.warningCount <= 0)
    return false;
  if (snapshotMetadata.warnings.length === 0) return false;
  let foundAllowedBlockingWarning = false;
  for (const warning of snapshotMetadata.warnings) {
    if (warning.effect === "info") continue;
    if (!getAllowedRedemptionCapacityWarningReason(stablecoinId, warning)) return false;
    foundAllowedBlockingWarning = true;
  }
  return foundAllowedBlockingWarning;
}

function resolveCapacityNotes(
  stablecoinId: string,
  snapshotMetadata: ReserveSnapshotMetadataRecord | null | undefined,
): string[] {
  if (!canUseCapacityDespiteDegradedSync(stablecoinId, snapshotMetadata)) return [];
  const notes = new Set<string>();
  for (const warning of snapshotMetadata?.warnings ?? []) {
    const note = getAllowedRedemptionCapacityWarningReason(stablecoinId, warning);
    if (note) notes.add(note);
  }
  return [...notes];
}

function resolveCapacityReason(args: {
  snapshotMetadata: ReserveSnapshotMetadataRecord | null | undefined;
  isFresh: boolean;
  hasBlockingWarnings: boolean;
  hasScoringEligibleFreshness: boolean;
  telemetryCapacity: "direct" | "proxy" | "none";
  capacityTelemetryAvailable: boolean;
  capacityTelemetryInvalid: boolean;
  capacityKind: RedemptionLiveCapacityKind | null;
  freshnessKind: RedemptionLiveFreshnessKind | null;
  verifiedSourceTimestampIssue: "missing" | "future" | null;
  stablecoinId: string;
  canUseDegradedSyncCapacity: boolean;
}): string | null {
  if (!args.snapshotMetadata) return "Live reserve metadata unavailable";
  if (args.capacityTelemetryInvalid) return "Live redemption capacity telemetry is malformed; fresh valid metadata required";
  if (!args.isFresh) return "Live reserve metadata stale; fresh metadata required";
  if (args.snapshotMetadata.syncStatus !== "ok" && !args.canUseDegradedSyncCapacity) {
    return "Live reserve metadata degraded; latest snapshot not in ok state";
  }
  if (args.hasBlockingWarnings) return "Live reserve metadata degraded by reserve warnings";
  // Snapshot evidenceClass describes reserve-composition quality (e.g.
  // river-protocol-info TVL is weak-live-probe). Nested redemption
  // telemetry with a scoreable capacity kind and freshness is an independent
  // same-run probe and may still bound the route.
  if (
    !hasScoreableNestedRedemptionEvidence(args.capacityKind, args.freshnessKind) &&
    !SCORING_LIVE_RESERVE_EVIDENCE_CLASSES.includes(args.snapshotMetadata.evidenceClass)
  ) {
    return "Live reserve metadata uses weak or non-scoring evidence for redemption capacity";
  }
  if (args.capacityKind && !SCOREABLE_REDEMPTION_CAPACITY_KINDS.has(args.capacityKind)) {
    return `Live redemption capacity kind ${args.capacityKind} is display-only for scoring`;
  }
  if (args.freshnessKind === "verified-source-timestamp" && args.verifiedSourceTimestampIssue === "missing") {
    return "Live redemption capacity claims verified source freshness without a source timestamp";
  }
  if (args.freshnessKind === "verified-source-timestamp" && args.verifiedSourceTimestampIssue === "future") {
    return "Live redemption capacity claims verified source freshness with a future source timestamp";
  }
  if (!isRedemptionFreshnessAllowed(args.stablecoinId, args.freshnessKind, args.hasScoringEligibleFreshness)) {
    return args.freshnessKind === "unverified"
      ? "Live redemption capacity has unverified freshness; route-specific approval required"
      : "Live redemption capacity lacks scoreable freshness evidence";
  }
  const adapterCanEmitCapacity = args.telemetryCapacity !== "none";
  if (!args.hasScoringEligibleFreshness && !adapterCanEmitCapacity && !args.capacityTelemetryAvailable) {
    return "Live reserve metadata lacks scoring-grade freshness evidence";
  }
  if (!adapterCanEmitCapacity && !args.capacityTelemetryAvailable) {
    return `Live reserve adapter for ${args.stablecoinId} does not expose redeemable-capacity telemetry`;
  }
  if (!args.capacityTelemetryAvailable) {
    return "Live reserve metadata lacks redeemable-capacity amount";
  }
  return null;
}

function resolveFeeReason(args: {
  snapshotMetadata: ReserveSnapshotMetadataRecord | null | undefined;
  isFresh: boolean;
  hasBlockingWarnings: boolean;
  hasScoringEligibleFreshness: boolean;
  telemetryFee: "current-bps" | "none";
  fallbackTelemetryAvailable: boolean;
  feeTelemetryInvalid: boolean;
  stablecoinId: string;
}): string | null {
  if (!args.snapshotMetadata) return "Live redemption fee telemetry unavailable";
  if (args.feeTelemetryInvalid) return "Live redemption fee telemetry is malformed; using reviewed fee model instead";
  if (!args.isFresh) return "Live redemption fee telemetry stale; using reviewed fee model instead";
  if (args.snapshotMetadata.syncStatus !== "ok")
    return "Live redemption fee telemetry degraded; latest snapshot not in ok state";
  if (args.hasBlockingWarnings) return "Live redemption fee telemetry degraded by reserve warnings";
  const hasFeeTelemetry = args.telemetryFee !== "none" || args.fallbackTelemetryAvailable;
  if (!args.hasScoringEligibleFreshness && !hasFeeTelemetry) {
    return "Live redemption fee telemetry lacks trustworthy freshness evidence";
  }
  if (!hasFeeTelemetry) {
    return `Live reserve adapter for ${args.stablecoinId} does not expose redemption-fee telemetry`;
  }
  return null;
}

interface TelemetryBundle {
  nestedCapacityUsd: ParsedTelemetryNumber;
  nestedCapacityRatio: ParsedTelemetryNumber;
  legacyCapacityUsd: ParsedTelemetryNumber;
  legacyCapacityRatio: ParsedTelemetryNumber;
  nestedFeeBps: ParsedTelemetryNumber;
  legacyFeeBps: ParsedTelemetryNumber;
  buyFeeBpsMin: ParsedTelemetryNumber;
  buyFeeBpsMax: ParsedTelemetryNumber;
  sourceTimestamp: ParsedTelemetryNumber;
  settlementDelaySec: ParsedTelemetryNumber;
  queueDepthUsd: ParsedTelemetryNumber;
  dailyLimitUsd: ParsedTelemetryNumber;
  minRedeemUsd: ParsedTelemetryNumber;
  settlementBoundUnproven: boolean;
  capacityKind: RedemptionLiveCapacityKind | null;
  freshnessKind: RedemptionLiveFreshnessKind | null;
}

function parseTelemetryFields(
  redemptionTelemetry: Record<string, unknown>,
  metadata: Record<string, unknown>,
): TelemetryBundle {
  return {
    nestedCapacityUsd: parseTelemetryNumber(redemptionTelemetry, "capacityUsd", "Live redemption capacity USD", {
      min: 0,
    }),
    nestedCapacityRatio: parseTelemetryNumber(
      redemptionTelemetry,
      "capacityRatioOfSupply",
      "Live redemption capacity ratio",
      { min: 0, max: 1 },
    ),
    legacyCapacityUsd: parseTelemetryNumber(metadata, "immediateRedeemableUsd", "Legacy redemption capacity USD", {
      min: 0,
    }),
    legacyCapacityRatio: parseTelemetryNumber(
      metadata,
      "immediateRedeemableRatio",
      "Legacy redemption capacity ratio",
      { min: 0, max: 1 },
    ),
    nestedFeeBps: parseTelemetryNumber(redemptionTelemetry, "feeBps", "Live redemption fee bps", {
      min: 0,
      max: 10_000,
    }),
    legacyFeeBps: parseTelemetryNumber(metadata, "redemptionFeeBps", "Legacy redemption fee bps", {
      min: 0,
      max: 10_000,
    }),
    buyFeeBpsMin: parseTelemetryNumber(metadata, "buyFeeBpsMin", "Live buy-fee minimum bps", {
      min: 0,
      max: 10_000,
    }),
    buyFeeBpsMax: parseTelemetryNumber(metadata, "buyFeeBpsMax", "Live buy-fee maximum bps", {
      min: 0,
      max: 10_000,
    }),
    sourceTimestamp: parseTelemetryNumber(redemptionTelemetry, "sourceTimestamp", "Live redemption source timestamp", {
      min: 0,
    }),
    settlementDelaySec: parseTelemetryNumber(
      redemptionTelemetry,
      "settlementDelaySec",
      "Live redemption settlement delay",
      { min: 0 },
    ),
    queueDepthUsd: parseTelemetryNumber(redemptionTelemetry, "queueDepthUsd", "Live redemption queue depth", {
      min: 0,
    }),
    dailyLimitUsd: parseTelemetryNumber(redemptionTelemetry, "dailyLimitUsd", "Live redemption daily limit", {
      min: 0,
    }),
    minRedeemUsd: parseTelemetryNumber(redemptionTelemetry, "minRedeemUsd", "Live redemption minimum redeem", {
      min: 0,
    }),
    settlementBoundUnproven: redemptionTelemetry.settlementBoundUnproven === true,
    capacityKind: coerceSchemaValue(RedemptionLiveCapacityKindSchema, redemptionTelemetry.capacityKind),
    freshnessKind: coerceSchemaValue(RedemptionLiveFreshnessKindSchema, redemptionTelemetry.freshnessKind),
  };
}

interface ResolvedRouteStatus {
  routeStatus: RedemptionRouteStatus | null;
  routeStatusSource: RedemptionRouteStatusSource | null;
  routeStatusReason: string | null;
  routeStatusReviewedAt: string | null;
  /** Warning to surface in capacityNotes when route status was ignored, else null. */
  warning: string | null;
}

function resolveRouteStatus(redemptionTelemetry: Record<string, unknown>): ResolvedRouteStatus {
  const routeStatus = coerceRouteStatus(redemptionTelemetry.routeStatus);
  const routeStatusSource = coerceRouteStatusSource(redemptionTelemetry.routeStatusSource);
  const routeStatusMissingSource = routeStatus != null && routeStatusSource == null;
  const shouldUseSourcedRouteStatus = routeStatus != null && !routeStatusMissingSource;
  const shouldPreserveUnsourcedUnknownRouteStatus = routeStatus === "unknown" && routeStatusMissingSource;
  const warning = routeStatusMissingSource
    ? routeStatus === "unknown"
      ? "Live redemption route status is unknown without source attribution"
      : "Live redemption route status omitted source attribution and was ignored"
    : null;
  return {
    routeStatus: shouldUseSourcedRouteStatus || shouldPreserveUnsourcedUnknownRouteStatus ? routeStatus : null,
    routeStatusSource: shouldUseSourcedRouteStatus ? routeStatusSource : null,
    routeStatusReason: shouldUseSourcedRouteStatus ? coerceString(redemptionTelemetry.routeStatusReason) : null,
    routeStatusReviewedAt: shouldUseSourcedRouteStatus
      ? coerceReviewedAtDate(redemptionTelemetry.routeStatusReviewedAt)
      : null,
    warning,
  };
}

export function readRedemptionBackstopLiveMetadata(
  stablecoinId: string,
  snapshotMetadata: ReserveSnapshotMetadataRecord | null | undefined,
  now = Math.floor(Date.now() / 1000),
): RedemptionBackstopLiveMetadata {
  const metadata = snapshotMetadata?.metadata ?? {};
  const parsedRedemptionTelemetry = getRedemptionTelemetry(metadata);
  const redemptionTelemetry = parsedRedemptionTelemetry.fields;
  const redemptionTelemetryMalformed = parsedRedemptionTelemetry.malformed;
  const updatedAt = snapshotMetadata?.fetchedAt ?? null;
  const trackedMeta = TRACKED_META_BY_ID.get(stablecoinId);
  const adapterKey = trackedMeta?.liveReservesConfig?.adapter ?? null;
  const adapterDefinition = adapterKey ? getLiveReserveAdapterDefinition(adapterKey) : null;
  const isFresh = updatedAt != null && now - updatedAt <= LIVE_RESERVE_FRESHNESS_SEC;
  const hasScoringEligibleFreshness = hasScoringEligibleLiveReserveFreshness(metadata);
  const canUseDegradedSyncCapacity = canUseCapacityDespiteDegradedSync(stablecoinId, snapshotMetadata);
  const hasBlockingWarnings = hasBlockingRedemptionWarnings(
    stablecoinId,
    snapshotMetadata?.warnings ?? [],
    snapshotMetadata?.warningCount ?? 0,
  );
  const capacityNotes = resolveCapacityNotes(stablecoinId, snapshotMetadata);
  const telemetryCapacity = adapterDefinition?.redemptionTelemetry.capacity ?? "none";
  const telemetryFee = adapterDefinition?.redemptionTelemetry.fee ?? "none";
  const {
    nestedCapacityUsd,
    nestedCapacityRatio,
    legacyCapacityUsd,
    legacyCapacityRatio,
    nestedFeeBps,
    legacyFeeBps,
    buyFeeBpsMin,
    buyFeeBpsMax,
    sourceTimestamp,
    settlementDelaySec,
    queueDepthUsd,
    dailyLimitUsd,
    minRedeemUsd,
    settlementBoundUnproven,
    capacityKind,
    freshnessKind,
  } = parseTelemetryFields(redemptionTelemetry, metadata);
  const parsedOutputValuation = LiveReserveRedemptionOutputValuationSchema.safeParse(
    redemptionTelemetry.outputValuation,
  );
  const outputValuationPresent = Object.prototype.hasOwnProperty.call(
    redemptionTelemetry,
    "outputValuation",
  );
  const outputValuationUnknownAsset =
    parsedOutputValuation.success &&
    parsedOutputValuation.data.basketWeights.some(
      (weight) => !TRACKED_META_BY_ID.has(weight.assetId),
    );
  const outputValuationFuture =
    parsedOutputValuation.success &&
    parsedOutputValuation.data.observedAt > now + MAX_FUTURE_REDEMPTION_SOURCE_TIMESTAMP_SKEW_SEC;
  const sourceTimestampFuture =
    sourceTimestamp.value != null &&
    sourceTimestamp.value > now + MAX_FUTURE_REDEMPTION_SOURCE_TIMESTAMP_SKEW_SEC;
  const validSourceTimestamp = sourceTimestampFuture ? null : sourceTimestamp.value;
  const verifiedSourceTimestampIssue =
    freshnessKind === "verified-source-timestamp"
      ? sourceTimestampFuture
        ? "future"
        : validSourceTimestamp == null
          ? "missing"
          : null
      : null;
  const hasNestedCapacityTelemetry =
    redemptionTelemetryMalformed || hasTelemetryValue(nestedCapacityUsd) || hasTelemetryValue(nestedCapacityRatio);
  const hasLegacyCapacityTelemetry = hasTelemetryValue(legacyCapacityUsd) || hasTelemetryValue(legacyCapacityRatio);
  const capacityTelemetryInvalid = redemptionTelemetryMalformed
    ? true
    : hasNestedCapacityTelemetry
      ? nestedCapacityUsd.invalid || nestedCapacityRatio.invalid
      : legacyCapacityUsd.invalid || legacyCapacityRatio.invalid;
  const hasNestedFeeTelemetry = redemptionTelemetryMalformed || hasTelemetryValue(nestedFeeBps);
  const feeTelemetryInvalid = redemptionTelemetryMalformed
    ? true
    : hasNestedFeeTelemetry
      ? nestedFeeBps.invalid
      : legacyFeeBps.invalid;
  const telemetryWarnings = collectTelemetryWarnings([
    ...(redemptionTelemetryMalformed
      ? [{ value: null, invalid: true, warning: "Live redemption telemetry is malformed and was ignored" }]
      : []),
    ...(hasNestedCapacityTelemetry || !hasLegacyCapacityTelemetry
      ? [nestedCapacityUsd, nestedCapacityRatio]
      : [legacyCapacityUsd, legacyCapacityRatio]),
    ...(hasNestedFeeTelemetry ? [nestedFeeBps] : [legacyFeeBps]),
    buyFeeBpsMin,
    buyFeeBpsMax,
    sourceTimestamp,
    settlementDelaySec,
    queueDepthUsd,
    dailyLimitUsd,
    minRedeemUsd,
  ]);
  if (outputValuationPresent && !parsedOutputValuation.success) {
    telemetryWarnings.push("Live redemption output valuation is malformed and was ignored");
  } else if (outputValuationUnknownAsset) {
    telemetryWarnings.push("Live redemption output valuation contains an untracked basket asset and was ignored");
  } else if (outputValuationFuture) {
    telemetryWarnings.push("Live redemption output valuation has a future source timestamp and was ignored");
  }
  const resolvedRouteStatus = resolveRouteStatus(redemptionTelemetry);
  if (sourceTimestampFuture) {
    telemetryWarnings.push(
      `Live redemption source timestamp is ${sourceTimestamp.value! - now}s in the future and was ignored`,
    );
  }
  if (verifiedSourceTimestampIssue === "missing" && !sourceTimestamp.invalid) {
    telemetryWarnings.push("Live redemption freshness is verified-source-timestamp without sourceTimestamp");
  }
  if (resolvedRouteStatus.warning) {
    telemetryWarnings.push(resolvedRouteStatus.warning);
  }
  const fallbackCapacityTelemetryAvailable =
    !capacityTelemetryInvalid &&
    (hasNestedCapacityTelemetry
      ? nestedCapacityUsd.value != null || nestedCapacityRatio.value != null
      : legacyCapacityUsd.value != null || legacyCapacityRatio.value != null);
  const fallbackFeeTelemetryAvailable =
    !feeTelemetryInvalid && (hasNestedFeeTelemetry ? nestedFeeBps.value != null : legacyFeeBps.value != null);
  const capacityReason = resolveCapacityReason({
    snapshotMetadata,
    isFresh,
    hasBlockingWarnings,
    hasScoringEligibleFreshness,
    telemetryCapacity,
    capacityTelemetryAvailable: fallbackCapacityTelemetryAvailable,
    capacityTelemetryInvalid,
    capacityKind,
    freshnessKind,
    verifiedSourceTimestampIssue,
    stablecoinId,
    canUseDegradedSyncCapacity,
  });
  const feeReason = resolveFeeReason({
    snapshotMetadata,
    isFresh,
    hasBlockingWarnings,
    hasScoringEligibleFreshness,
    telemetryFee,
    fallbackTelemetryAvailable: fallbackFeeTelemetryAvailable,
    feeTelemetryInvalid,
    stablecoinId,
  });

  return {
    updatedAt,
    isFresh,
    hasScoringEligibleFreshness,
    hasBlockingWarnings,
    capacityNotes: [...telemetryWarnings, ...capacityNotes],
    capacityConfidence:
      capacityTelemetryInvalid
        ? null
        : telemetryCapacity === "direct"
        ? "live-direct"
        : telemetryCapacity === "proxy"
          ? "live-proxy"
          : fallbackCapacityTelemetryAvailable
            ? "dynamic"
            : null,
    canUseCapacity: capacityReason == null,
    canUseFee: feeReason == null,
    capacityReason,
    feeReason,
    immediateRedeemableUsd: capacityTelemetryInvalid
      ? null
      : hasNestedCapacityTelemetry
        ? nestedCapacityUsd.value
        : legacyCapacityUsd.value,
    immediateRedeemableRatio: capacityTelemetryInvalid
      ? null
      : hasNestedCapacityTelemetry
        ? (nestedCapacityRatio.value ?? (nestedCapacityUsd.value != null ? null : legacyCapacityRatio.value))
        : legacyCapacityRatio.value,
    settlementBoundUnproven,
    capacityKind,
    freshnessKind,
    sourceTimestamp: validSourceTimestamp,
    sourceUrls: coerceUrlArray(redemptionTelemetry.sourceUrls),
    settlementDelaySec: settlementDelaySec.value,
    queueDepthUsd: queueDepthUsd.value,
    dailyLimitUsd: dailyLimitUsd.value,
    minRedeemUsd: minRedeemUsd.value,
    liveHolderEligibility: coerceSchemaValue(RedemptionHolderEligibilitySchema, redemptionTelemetry.holderEligibility),
    redemptionFeeBps: feeTelemetryInvalid ? null : hasNestedFeeTelemetry ? nestedFeeBps.value : legacyFeeBps.value,
    buyFeeBpsMin: buyFeeBpsMin.value,
    buyFeeBpsMax: buyFeeBpsMax.value,
    routeStatus: resolvedRouteStatus.routeStatus,
    routeStatusSource: resolvedRouteStatus.routeStatusSource,
    routeStatusReason: resolvedRouteStatus.routeStatusReason,
    routeStatusReviewedAt: resolvedRouteStatus.routeStatusReviewedAt,
    v9FpiControllerRouteState: parseAcceptedFpiControllerV9RouteState(redemptionTelemetry.v9RouteAttempt),
    v9SfrxusdCrosschainRouteState:
      hasScoringEligibleFreshness &&
      !hasBlockingWarnings &&
      capacityReason == null
        ? parseAcceptedSfrxusdCrosschainV9RouteState(
            redemptionTelemetry.v9RouteAttempt,
          )
        : null,
    v9OutputValuation:
      parsedOutputValuation.success &&
      !outputValuationUnknownAsset &&
      !outputValuationFuture &&
      hasScoringEligibleFreshness &&
      !hasBlockingWarnings &&
      capacityReason == null
        ? parsedOutputValuation.data
        : null,
  };
}
