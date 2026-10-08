import { getLiveReserveAdapterDefinition, getLiveReserveAdapterValidationPolicy } from "@shared/lib/live-reserve-adapters";
import { getRedemptionBackstopConfig } from "@shared/lib/redemption-backstops";
import {
  getAllowedRedemptionCapacityWarningReason,
  isRedemptionFreshnessAllowedByPolicy,
} from "@shared/lib/redemption-backstop-configs/policies";
import { WORKER_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import { MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC, resolveLiveReserveSourceAgeBudget } from "@shared/lib/live-reserve-freshness";
import type {
  RedemptionCapacityConfidence,
  RedemptionCapacityRejectionReason,
  RedemptionHolderEligibility,
  RedemptionLiveCapacityKind,
  RedemptionLiveFreshnessKind,
  RedemptionRouteStatus,
  RedemptionRouteStatusSource,
} from "@shared/types/redemption";
import { decodeLiveReserveRedemptionTelemetry, type LiveReserveRedemptionTelemetry, type LiveReserveRedemptionTelemetryKnownFields } from "@shared/types/live-reserves";
import type { LiveReserveRedemptionOutputValuation, LiveReserveWarning } from "@shared/types/live-reserves";
import {
  hasScoringEligibleLiveReserveFreshness,
  LIVE_RESERVE_FRESHNESS_SEC,
  SCORING_LIVE_RESERVE_EVIDENCE_CLASSES,
  type ReserveSnapshotMetadataRecord,
} from "../live-reserves/store";
import {
  parseAcceptedFpiControllerV9RouteState,
  type FpiControllerV9RouteState,
} from "../fpi-controller-redemption-route";
import {
  parseAcceptedSfrxusdCrosschainV9RouteState,
  type SfrxusdCrosschainV9RouteState,
} from "../sfrxusd-crosschain-redemption-route";

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
  capacityRejectionReason?: RedemptionCapacityRejectionReason | null;
  feeReason: string | null;
  immediateRedeemableUsd: number | null;
  immediateRedeemableRatio: number | null;
  settlementBoundUnproven: boolean;
  capacityKind: RedemptionLiveCapacityKind | null;
  freshnessKind: RedemptionLiveFreshnessKind | null;
  sourceTimestamp: number | null;
  evidenceObservedAt: number | null;
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
  outputAssetKeys?: string[] | null;
  sharedResourceKey?: string | null;
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


function coerceString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
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
const MAX_FUTURE_REDEMPTION_SOURCE_TIMESTAMP_SKEW_SEC = MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC;

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

/** Capacity scope cannot repair composition, authority, or immutable generation. */
export function evaluateRedemptionCapacityEvidenceAdmission(
  stablecoinId: string,
  snapshot: ReserveSnapshotMetadataRecord | null | undefined,
  now: number,
): {
  eligible: boolean;
  rejectionReason: RedemptionCapacityRejectionReason | null;
  independentNestedEvidence: boolean;
} {
  const reject = (rejectionReason: RedemptionCapacityRejectionReason) => ({
    eligible: false, rejectionReason, independentNestedEvidence: false,
  });
  if (!snapshot) return reject("missing-snapshot");
  const reasons = snapshot.admission?.reasons ?? [];
  const strictReason = reasons.find((reason) =>
    reason !== "non-independent" && reason !== "degraded-snapshot" &&
    reason !== "insufficient-slices" && reason !== "invalid-freshness",
  );
  if (strictReason) return reject(strictReason);
  if (!Number.isSafeInteger(snapshot.fetchedAt) || snapshot.fetchedAt <= 0 || snapshot.fetchedAt > now) {
    return reject("invalid-freshness");
  }
  if (now - snapshot.fetchedAt > LIVE_RESERVE_FRESHNESS_SEC) return reject("stale");
  const parsed = decodeLiveReserveRedemptionTelemetry(snapshot.metadata);
  if (parsed.status === "invalid") return reject("malformed-telemetry");
  const telemetry = parsed.status === "valid" ? parsed.telemetry : {};
  const meta = WORKER_TRACKED_META_BY_ID.get(stablecoinId);
  const adapterValidation = meta?.liveReservesConfig && getLiveReserveAdapterValidationPolicy(meta.liveReservesConfig.adapter);
  const { sourceAgeBudgetSec } = resolveLiveReserveSourceAgeBudget(
    meta?.liveReservesConfig?.scoring?.maxSourceAgeSec, adapterValidation?.maxSourceAgeSec, LIVE_RESERVE_FRESHNESS_SEC,
  );
  if (snapshot.metadata.freshnessMode === "verified") {
    const compositionTimestamp = snapshot.metadata.sourceTimestamp;
    if (typeof compositionTimestamp !== "number" || !Number.isFinite(compositionTimestamp) ||
      compositionTimestamp <= 0 || compositionTimestamp > now + MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC) {
      return reject("invalid-freshness");
    }
    if (now - compositionTimestamp > sourceAgeBudgetSec) return reject("stale");
  }
  if (telemetry.sourceTimestamp != null) {
    if (telemetry.sourceTimestamp <= 0) return reject("missing-source-timestamp");
    if (telemetry.sourceTimestamp > now + MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC) return reject("future-source-timestamp");
    const nestedSourceBudget = telemetry.freshnessKind === "verified-source-timestamp"
      ? sourceAgeBudgetSec : Math.min(sourceAgeBudgetSec, LIVE_RESERVE_FRESHNESS_SEC);
    if (now - telemetry.sourceTimestamp > nestedSourceBudget) return reject("stale-source-timestamp");
  }
  const requiresIndependentNested = reasons.includes("invalid-freshness") ||
    (snapshot.metadata.freshnessMode === "unverified" && telemetry.freshnessKind !== "unverified");
  if (requiresIndependentNested) {
    // Only timestamp-less composition is separable. A broken/future disclosure
    // or invalid fetch clock is not a scope mismatch.
    if (snapshot.metadata.freshnessMode !== "unverified" ||
      snapshot.metadata.diag?.invalidFreshness === true ||
      snapshot.admission?.freshness?.sourceFreshnessInvalid === true) return reject("invalid-freshness");
    if (telemetry.freshnessKind !== "same-run-onchain" ||
      !hasScoreableNestedRedemptionEvidence(telemetry.capacityKind ?? null, telemetry.freshnessKind)) {
      return reject("invalid-freshness");
    }
    if (telemetry.sourceTimestamp == null) return reject("missing-source-timestamp");
    if (!Number.isSafeInteger(telemetry.blockNumber) || (telemetry.blockNumber ?? 0) <= 0) return reject("missing-block-number");
    const model = getRedemptionBackstopConfig(stablecoinId)?.capacityModel;
    const requiredOutputs = model?.kind === "reserve-sync-metadata" || model?.kind === "executable-observer"
      ? model.requiredOutputAssetKeys : undefined;
    if (!requiredOutputs?.length ||
      !requiredOutputs.every((key) => telemetry.outputAssetKeys?.includes(key))) {
      return reject("route-output-identity-unobserved");
    }
    if (telemetry.routeStatusSource !== "onchain" || telemetry.holderEligibility == null) return reject("invalid-freshness");
    if (telemetry.capacityUsd == null && telemetry.capacityRatioOfSupply == null) return reject("redeemable-capacity-unobserved");
  }
  return { eligible: true, rejectionReason: null, independentNestedEvidence: requiresIndependentNested };
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
  nestedFeeBps: ParsedTelemetryNumber;
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
  redemptionTelemetry: LiveReserveRedemptionTelemetryKnownFields,
  metadata: Record<string, unknown>,
): TelemetryBundle {
  return {
    nestedCapacityUsd: { value: redemptionTelemetry.capacityUsd ?? null, invalid: false },
    nestedCapacityRatio: { value: redemptionTelemetry.capacityRatioOfSupply ?? null, invalid: false },
    nestedFeeBps: { value: redemptionTelemetry.feeBps ?? null, invalid: false },
    buyFeeBpsMin: parseTelemetryNumber(metadata, "buyFeeBpsMin", "Live buy-fee minimum bps", {
      min: 0,
      max: 10_000,
    }),
    buyFeeBpsMax: parseTelemetryNumber(metadata, "buyFeeBpsMax", "Live buy-fee maximum bps", {
      min: 0,
      max: 10_000,
    }),
    sourceTimestamp: { value: redemptionTelemetry.sourceTimestamp ?? null, invalid: false },
    settlementDelaySec: { value: redemptionTelemetry.settlementDelaySec ?? null, invalid: false },
    queueDepthUsd: { value: redemptionTelemetry.queueDepthUsd ?? null, invalid: false },
    dailyLimitUsd: { value: redemptionTelemetry.dailyLimitUsd ?? null, invalid: false },
    minRedeemUsd: { value: redemptionTelemetry.minRedeemUsd ?? null, invalid: false },
    settlementBoundUnproven: redemptionTelemetry.settlementBoundUnproven === true,
    capacityKind: redemptionTelemetry.capacityKind ?? null,
    freshnessKind: redemptionTelemetry.freshnessKind ?? null,
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

function resolveRouteStatus(redemptionTelemetry: LiveReserveRedemptionTelemetryKnownFields): ResolvedRouteStatus {
  const routeStatus = redemptionTelemetry.routeStatus === "suspended" ? null : redemptionTelemetry.routeStatus ?? null;
  const routeStatusSource = redemptionTelemetry.routeStatusSource ?? null;
  const routeStatusMissingSource = routeStatus != null && routeStatusSource == null;
  const shouldUseSourcedRouteStatus = routeStatus != null && !routeStatusMissingSource;
  const shouldPreserveUnsourcedUnknownRouteStatus = routeStatus === "unknown" && routeStatusMissingSource;
  const warning = redemptionTelemetry.routeStatus === "suspended"
    ? "Live redemption suspended status requires authored routeSuspension evidence and was ignored"
    : routeStatusMissingSource
    ? routeStatus === "unknown"
      ? "Live redemption route status is unknown without source attribution"
      : "Live redemption route status omitted source attribution and was ignored"
    : null;
  return {
    routeStatus: shouldUseSourcedRouteStatus || shouldPreserveUnsourcedUnknownRouteStatus ? routeStatus : null,
    routeStatusSource: shouldUseSourcedRouteStatus ? routeStatusSource : null,
    routeStatusReason: shouldUseSourcedRouteStatus ? coerceString(redemptionTelemetry.routeStatusReason) : null,
    routeStatusReviewedAt: shouldUseSourcedRouteStatus
      ? redemptionTelemetry.routeStatusReviewedAt ?? null
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
  const parsedRedemptionTelemetry = decodeLiveReserveRedemptionTelemetry(metadata);
  const redemptionTelemetry: LiveReserveRedemptionTelemetry = parsedRedemptionTelemetry.status === "valid" ? parsedRedemptionTelemetry.telemetry : {};
  const redemptionTelemetryMalformed = parsedRedemptionTelemetry.status === "invalid";
  const updatedAt = snapshotMetadata?.fetchedAt ?? null;
  const trackedMeta = WORKER_TRACKED_META_BY_ID.get(stablecoinId);
  const adapterKey = trackedMeta?.liveReservesConfig?.adapter ?? null;
  const adapterDefinition = adapterKey ? getLiveReserveAdapterDefinition(adapterKey) : null;
  const isFresh = updatedAt != null && Number.isSafeInteger(updatedAt) && updatedAt > 0 && updatedAt <= now &&
    now - updatedAt <= LIVE_RESERVE_FRESHNESS_SEC;
  const hasScoringEligibleFreshness = hasScoringEligibleLiveReserveFreshness(metadata, now);
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
    nestedFeeBps,
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
  const outputValuation = redemptionTelemetry.outputValuation;
  const configuredOutputKeys = new Set([
    ...(getRedemptionBackstopConfig(stablecoinId)?.outputAssets ?? []),
    ...(getRedemptionBackstopConfig(stablecoinId)?.unresolvedOutputAssetKeys ?? []),
  ]);
  const outputValuationUnknownAsset =
    outputValuation != null &&
    outputValuation.basketWeights.some(
      (weight) => !WORKER_TRACKED_META_BY_ID.has(weight.assetId) && !configuredOutputKeys.has(weight.assetId),
    );
  const outputValuationFuture =
    outputValuation != null &&
    outputValuation.observedAt > now + MAX_FUTURE_REDEMPTION_SOURCE_TIMESTAMP_SKEW_SEC;
  const sourceTimestampFuture =
    sourceTimestamp.value != null &&
    sourceTimestamp.value > now + MAX_FUTURE_REDEMPTION_SOURCE_TIMESTAMP_SKEW_SEC;
  const validSourceTimestamp = sourceTimestampFuture ? null : sourceTimestamp.value;
  const sameRunFreshness = freshnessKind === "same-run-onchain" || freshnessKind === "same-run-api";
  const evidenceObservedAt = validSourceTimestamp ?? (
    sameRunFreshness && updatedAt != null && Number.isFinite(updatedAt) && updatedAt >= 0 &&
    updatedAt <= now + MAX_FUTURE_REDEMPTION_SOURCE_TIMESTAMP_SKEW_SEC
      ? updatedAt
      : null
  );
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
  const capacityTelemetryInvalid = redemptionTelemetryMalformed
    ? true
    : nestedCapacityUsd.invalid || nestedCapacityRatio.invalid;
  const hasNestedFeeTelemetry = redemptionTelemetryMalformed || hasTelemetryValue(nestedFeeBps);
  const feeTelemetryInvalid = redemptionTelemetryMalformed ? true : nestedFeeBps.invalid;
  const telemetryWarnings = collectTelemetryWarnings([
    ...(redemptionTelemetryMalformed
      ? [{ value: null, invalid: true, warning: "Live redemption telemetry is malformed and was ignored" }]
      : []),
    ...(hasNestedCapacityTelemetry ? [nestedCapacityUsd, nestedCapacityRatio] : []),
    ...(hasNestedFeeTelemetry ? [nestedFeeBps] : []),
    buyFeeBpsMin,
    buyFeeBpsMax,
    sourceTimestamp,
    settlementDelaySec,
    queueDepthUsd,
    dailyLimitUsd,
    minRedeemUsd,
  ]);
  if (outputValuationUnknownAsset) {
    telemetryWarnings.push(
      "Live redemption output valuation contains an asset outside the reviewed route output set and was ignored",
    );
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
    (hasNestedCapacityTelemetry ? nestedCapacityUsd.value != null || nestedCapacityRatio.value != null : false);
  const fallbackFeeTelemetryAvailable =
    !feeTelemetryInvalid && (hasNestedFeeTelemetry ? nestedFeeBps.value != null : false);
  const admission = evaluateRedemptionCapacityEvidenceAdmission(stablecoinId, snapshotMetadata, now);
  const model = getRedemptionBackstopConfig(stablecoinId)?.capacityModel;
  const requiredOutputs = model?.kind === "reserve-sync-metadata" || model?.kind === "executable-observer"
    ? model.requiredOutputAssetKeys : undefined;
  const outputIdentityMissing = !!requiredOutputs?.length &&
    !requiredOutputs.every((key) => redemptionTelemetry.outputAssetKeys?.includes(key));
  const settlementBoundCapacityUnavailable = settlementBoundUnproven &&
    !(resolvedRouteStatus.routeStatus === "paused" && (nestedCapacityUsd.value ?? nestedCapacityRatio.value) === 0);
  const capacityRejectionReason: RedemptionCapacityRejectionReason | null = admission.rejectionReason ??
    (capacityTelemetryInvalid ? "malformed-telemetry" :
      !isFresh ? "stale" :
      snapshotMetadata?.syncStatus !== "ok" && !canUseDegradedSyncCapacity ? "degraded-snapshot" :
      hasBlockingWarnings ? "degraded-snapshot" :
      capacityKind && !SCOREABLE_REDEMPTION_CAPACITY_KINDS.has(capacityKind) ? "unsupported-capacity-kind" :
      verifiedSourceTimestampIssue === "missing" ? "missing-source-timestamp" :
      verifiedSourceTimestampIssue === "future" ? "future-source-timestamp" :
      !isRedemptionFreshnessAllowed(stablecoinId, freshnessKind, hasScoringEligibleFreshness) ? "invalid-freshness" :
      outputIdentityMissing ? "route-output-identity-unobserved" :
      settlementBoundCapacityUnavailable ? "settlement-bound-unproven" :
      !fallbackCapacityTelemetryAvailable ? "redeemable-capacity-unobserved" : null);
  const capacityReason = admission.rejectionReason
    ? `Live redemption evidence rejected: ${admission.rejectionReason}`
    : outputIdentityMissing
      ? "Live redemption evidence does not bind the selected route output"
      : settlementBoundCapacityUnavailable
        ? "Live redemption settlement completion bound is unproven"
        : resolveCapacityReason({
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
  const feeReason = admission.rejectionReason &&
    admission.rejectionReason !== "route-output-identity-unobserved" &&
    admission.rejectionReason !== "redeemable-capacity-unobserved"
    ? `Live redemption fee evidence rejected: ${admission.rejectionReason}`
    : resolveFeeReason({
    snapshotMetadata,
    isFresh,
    hasBlockingWarnings,
    hasScoringEligibleFreshness,
    telemetryFee,
    fallbackTelemetryAvailable: fallbackFeeTelemetryAvailable,
    feeTelemetryInvalid,
    stablecoinId,
  });
  const preserveEvidence = admission.eligible && isFresh && !hasBlockingWarnings && !redemptionTelemetryMalformed &&
    (snapshotMetadata?.syncStatus === "ok" || canUseDegradedSyncCapacity);
  // Rejected positive evidence must not erase an independently observed pause,
  // route impairment, daily limit, or asynchronous settlement constraint.
  const preserveRouteStatus = preserveEvidence ||
    (resolvedRouteStatus.routeStatus != null && resolvedRouteStatus.routeStatus !== "open");

  const outputAssetKeys = redemptionTelemetry.outputAssetKeys ?? null;
  return {
    updatedAt,
    isFresh,
    hasScoringEligibleFreshness,
    hasBlockingWarnings,
    capacityNotes: [...telemetryWarnings, ...capacityNotes],
    outputAssetKeys,
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
    canUseCapacity: capacityReason == null && capacityRejectionReason == null,
    canUseFee: feeReason == null,
    capacityReason,
    capacityRejectionReason,
    feeReason,
    immediateRedeemableUsd: !preserveEvidence || capacityTelemetryInvalid || settlementBoundCapacityUnavailable
      ? null
      : hasNestedCapacityTelemetry
        ? nestedCapacityUsd.value
        : null,
    immediateRedeemableRatio: !preserveEvidence || capacityTelemetryInvalid || settlementBoundCapacityUnavailable
      ? null
      : hasNestedCapacityTelemetry
        ? nestedCapacityRatio.value
        : null,
    settlementBoundUnproven,
    capacityKind,
    freshnessKind,
    sourceTimestamp: validSourceTimestamp,
    evidenceObservedAt: preserveEvidence ? evidenceObservedAt : null,
    sourceUrls: redemptionTelemetry.sourceUrls ?? [],
    settlementDelaySec: settlementDelaySec.value,
    queueDepthUsd: queueDepthUsd.value,
    dailyLimitUsd: dailyLimitUsd.value,
    minRedeemUsd: minRedeemUsd.value,
    liveHolderEligibility: redemptionTelemetry.holderEligibility ?? null,
    sharedResourceKey: preserveEvidence ? coerceString(redemptionTelemetry.sharedResourceKey) : null,
    redemptionFeeBps: feeTelemetryInvalid ? null : hasNestedFeeTelemetry ? nestedFeeBps.value : null,
    buyFeeBpsMin: buyFeeBpsMin.value,
    buyFeeBpsMax: buyFeeBpsMax.value,
    routeStatus: preserveRouteStatus ? resolvedRouteStatus.routeStatus : null,
    routeStatusSource: preserveRouteStatus ? resolvedRouteStatus.routeStatusSource : null,
    routeStatusReason: preserveRouteStatus ? resolvedRouteStatus.routeStatusReason : null,
    routeStatusReviewedAt: preserveRouteStatus ? resolvedRouteStatus.routeStatusReviewedAt : null,
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
      outputValuation != null &&
      !outputValuationUnknownAsset &&
      !outputValuationFuture &&
      hasScoringEligibleFreshness &&
      !hasBlockingWarnings &&
      capacityReason == null
        ? outputValuation
        : null,
  };
}
