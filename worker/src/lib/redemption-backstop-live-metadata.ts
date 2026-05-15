import { getLiveReserveAdapterDefinition } from "@shared/lib/live-reserve-adapters";
import {
  getAllowedRedemptionCapacityWarningReason,
  isRedemptionFreshnessAllowedByPolicy,
} from "@shared/lib/redemption-backstop-configs/policies";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import type {
  RedemptionCapacityConfidence,
  RedemptionHolderEligibility,
  RedemptionLiveCapacityKind,
  RedemptionLiveFreshnessKind,
  RedemptionRouteStatus,
  RedemptionRouteStatusSource,
} from "@shared/types/redemption";
import {
  RedemptionHolderEligibilitySchema,
  RedemptionLiveCapacityKindSchema,
  RedemptionLiveFreshnessKindSchema,
} from "@shared/types/redemption";
import type { LiveReserveWarning } from "@shared/types/live-reserves";
import type { ReserveSnapshotMetadataRecord } from "./live-reserves-store";
import { LIVE_RESERVE_FRESHNESS_SEC } from "./live-reserves-store";
import { SCORING_LIVE_RESERVE_EVIDENCE_CLASSES } from "./live-reserves-store-shared";
import { hasScoringEligibleLiveReserveFreshness } from "./live-reserves-store-snapshot-state";

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
}

function coerceFiniteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function coerceNonNegativeFiniteNumber(value: unknown): number | null {
  const parsed = coerceFiniteNumber(value);
  return parsed != null && parsed >= 0 ? parsed : null;
}

function getRedemptionTelemetry(metadata: Record<string, unknown>): Record<string, unknown> {
  return metadata.redemption && typeof metadata.redemption === "object" && !Array.isArray(metadata.redemption)
    ? (metadata.redemption as Record<string, unknown>)
    : {};
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
  capacityKind: RedemptionLiveCapacityKind | null;
  freshnessKind: RedemptionLiveFreshnessKind | null;
  stablecoinId: string;
  canUseDegradedSyncCapacity: boolean;
}): string | null {
  if (!args.snapshotMetadata) return "Live reserve metadata unavailable";
  if (!args.isFresh) return "Live reserve metadata stale; fresh metadata required";
  if (args.snapshotMetadata.syncStatus !== "ok" && !args.canUseDegradedSyncCapacity) {
    return "Live reserve metadata degraded; latest snapshot not in ok state";
  }
  if (args.hasBlockingWarnings) return "Live reserve metadata degraded by reserve warnings";
  if (!SCORING_LIVE_RESERVE_EVIDENCE_CLASSES.includes(args.snapshotMetadata.evidenceClass)) {
    return "Live reserve metadata uses weak or non-scoring evidence for redemption capacity";
  }
  if (args.capacityKind && !SCOREABLE_REDEMPTION_CAPACITY_KINDS.has(args.capacityKind)) {
    return `Live redemption capacity kind ${args.capacityKind} is display-only for scoring`;
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
  stablecoinId: string;
}): string | null {
  if (!args.snapshotMetadata) return "Live redemption fee telemetry unavailable";
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

export function readRedemptionBackstopLiveMetadata(
  stablecoinId: string,
  snapshotMetadata: ReserveSnapshotMetadataRecord | null | undefined,
  now = Math.floor(Date.now() / 1000),
): RedemptionBackstopLiveMetadata {
  const metadata = snapshotMetadata?.metadata ?? {};
  const redemptionTelemetry = getRedemptionTelemetry(metadata);
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
  const nestedCapacityUsd = coerceFiniteNumber(redemptionTelemetry.capacityUsd);
  const nestedCapacityRatio = coerceFiniteNumber(redemptionTelemetry.capacityRatioOfSupply);
  const capacityKind = coerceSchemaValue(RedemptionLiveCapacityKindSchema, redemptionTelemetry.capacityKind);
  const freshnessKind = coerceSchemaValue(RedemptionLiveFreshnessKindSchema, redemptionTelemetry.freshnessKind);
  const legacyCapacityUsd = coerceFiniteNumber(metadata.immediateRedeemableUsd);
  const legacyCapacityRatio = coerceFiniteNumber(metadata.immediateRedeemableRatio);
  const fallbackCapacityTelemetryAvailable =
    nestedCapacityUsd != null ||
    legacyCapacityUsd != null ||
    nestedCapacityRatio != null ||
    legacyCapacityRatio != null;
  const fallbackFeeTelemetryAvailable =
    coerceFiniteNumber(redemptionTelemetry.feeBps) != null || coerceFiniteNumber(metadata.redemptionFeeBps) != null;
  const capacityReason = resolveCapacityReason({
    snapshotMetadata,
    isFresh,
    hasBlockingWarnings,
    hasScoringEligibleFreshness,
    telemetryCapacity,
    capacityTelemetryAvailable: fallbackCapacityTelemetryAvailable,
    capacityKind,
    freshnessKind,
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
    stablecoinId,
  });

  return {
    updatedAt,
    isFresh,
    hasScoringEligibleFreshness,
    hasBlockingWarnings,
    capacityNotes,
    capacityConfidence:
      telemetryCapacity === "direct"
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
    immediateRedeemableUsd: nestedCapacityUsd ?? legacyCapacityUsd,
    immediateRedeemableRatio: nestedCapacityRatio ?? (nestedCapacityUsd != null ? null : legacyCapacityRatio),
    capacityKind,
    freshnessKind,
    sourceTimestamp: coerceNonNegativeFiniteNumber(redemptionTelemetry.sourceTimestamp),
    sourceUrls: coerceUrlArray(redemptionTelemetry.sourceUrls),
    settlementDelaySec: coerceNonNegativeFiniteNumber(redemptionTelemetry.settlementDelaySec),
    queueDepthUsd: coerceNonNegativeFiniteNumber(redemptionTelemetry.queueDepthUsd),
    dailyLimitUsd: coerceNonNegativeFiniteNumber(redemptionTelemetry.dailyLimitUsd),
    minRedeemUsd: coerceNonNegativeFiniteNumber(redemptionTelemetry.minRedeemUsd),
    liveHolderEligibility: coerceSchemaValue(RedemptionHolderEligibilitySchema, redemptionTelemetry.holderEligibility),
    redemptionFeeBps: coerceFiniteNumber(redemptionTelemetry.feeBps) ?? coerceFiniteNumber(metadata.redemptionFeeBps),
    buyFeeBpsMin: coerceFiniteNumber(metadata.buyFeeBpsMin),
    buyFeeBpsMax: coerceFiniteNumber(metadata.buyFeeBpsMax),
    routeStatus: coerceRouteStatus(redemptionTelemetry.routeStatus),
    routeStatusSource: coerceRouteStatusSource(redemptionTelemetry.routeStatusSource),
    routeStatusReason: coerceString(redemptionTelemetry.routeStatusReason),
    routeStatusReviewedAt: coerceReviewedAtDate(redemptionTelemetry.routeStatusReviewedAt),
  };
}
