import { z } from "zod";
import { LIVE_RESERVE_ADAPTER_KEYS, type LiveReserveAdapterKey } from "./live-reserve-adapter-keys";
import type {
  LiveReserveEvidenceClass,
  LiveReserveFreshnessMode,
  LiveReserveInput,
  LiveReserveSemantics,
  LiveReserveSourceModel,
  LiveReserveWarningEffect,
  ReserveDisplayBadgeKind,
} from "./live-reserve-core";
import {
  LIVE_RESERVE_EVIDENCE_CLASS_VALUES,
  LIVE_RESERVE_FRESHNESS_MODE_VALUES,
  LIVE_RESERVE_SOURCE_MODEL_VALUES,
  RESERVE_DISPLAY_BADGE_KIND_VALUES,
} from "./live-reserve-core";
import { ReserveSliceSchema, type ReserveSlice } from "./reserves";
import { HttpUrlSchema } from "./validators";
import {
  RedemptionHolderEligibilitySchema,
  type RedemptionHolderEligibility,
  RedemptionLiveCapacityKindValues,
  RedemptionLiveFreshnessKindValues,
  RedemptionRouteStatusSchema,
  RedemptionRouteStatusSourceSchema,
} from "./redemption";

export { LIVE_RESERVE_ADAPTER_KEYS, type LiveReserveAdapterKey };
export * from "./live-reserve-core";

export const LIVE_RESERVE_REDEMPTION_CAPACITY_KIND_VALUES = [...RedemptionLiveCapacityKindValues] as const;

export const LIVE_RESERVE_REDEMPTION_FRESHNESS_KIND_VALUES = [...RedemptionLiveFreshnessKindValues] as const;

export const LIVE_RESERVE_REDEMPTION_ROUTE_STATUS_VALUES = RedemptionRouteStatusSchema.options;

export const LIVE_RESERVE_REDEMPTION_ROUTE_STATUS_SOURCE_VALUES = RedemptionRouteStatusSourceSchema.options;

export type LiveReserveRedemptionCapacityKind = (typeof LIVE_RESERVE_REDEMPTION_CAPACITY_KIND_VALUES)[number];
export type LiveReserveRedemptionFreshnessKind = (typeof LIVE_RESERVE_REDEMPTION_FRESHNESS_KIND_VALUES)[number];
export type LiveReserveRedemptionRouteStatus = (typeof LIVE_RESERVE_REDEMPTION_ROUTE_STATUS_VALUES)[number];
export type LiveReserveRedemptionRouteStatusSource =
  (typeof LIVE_RESERVE_REDEMPTION_ROUTE_STATUS_SOURCE_VALUES)[number];

export interface LiveReserveWarning {
  code: string;
  message: string;
  severity: "info" | "warning";
  effect: LiveReserveWarningEffect;
}

export interface LiveReserveSnapshotMetadata extends Record<string, unknown> {
  sourceTimestamp?: number;
  freshnessMode?: LiveReserveFreshnessMode;
  scoringAllowsUnverifiedFreshness?: boolean;
  unknownExposurePct?: number;
  yieldBasisCollateralUsd?: number;
  yieldBasisCollateralPct?: number;
  supplyUsd?: number;
  totalReserveUsd?: number;
  totalAssetsUsd?: number;
  totalLiabilitiesUsd?: number;
  shareholderEquityUsd?: number;
  collateralizationRatio?: number;
  liquidationCapacityRatio?: number;
  immediateRedeemableUsd?: number;
  immediateRedeemableRatio?: number;
  redemptionFeeBps?: number;
  buyFeeBpsMin?: number;
  buyFeeBpsMax?: number;
  redemption?: LiveReserveRedemptionTelemetry;
  details?: Record<string, unknown>;
}

export interface LiveReserveRedemptionTelemetry extends Record<string, unknown> {
  capacityUsd?: number;
  capacityRatioOfSupply?: number;
  capacityKind?: LiveReserveRedemptionCapacityKind;
  freshnessKind?: LiveReserveRedemptionFreshnessKind;
  sourceTimestamp?: number;
  blockNumber?: number;
  routeStatus?: LiveReserveRedemptionRouteStatus;
  routeStatusSource?: LiveReserveRedemptionRouteStatusSource;
  routeStatusReason?: string;
  routeStatusReviewedAt?: string;
  holderEligibility?: RedemptionHolderEligibility;
  settlementDelaySec?: number;
  queueDepthUsd?: number;
  dailyLimitUsd?: number;
  minRedeemUsd?: number;
  feeBps?: number;
  sourceUrls?: string[];
  /**
   * Optional producer-pinned value of a proportional redemption basket.
   * This is only score-bearing after the consumer verifies the source-bound
   * timestamp and complete normalized basket weights.
   */
  outputValuation?: LiveReserveRedemptionOutputValuation;
}

export interface LiveReserveRedemptionOutputValuation {
  sourceId: string;
  observedAt: number;
  unitValueUsd: number;
  basketWeights: Array<{
    assetId: string;
    weight: number;
  }>;
}

export const LiveReserveRedemptionOutputValuationSchema: z.ZodType<LiveReserveRedemptionOutputValuation> = z
  .object({
    sourceId: z.string().trim().min(1),
    observedAt: z.number().int().nonnegative(),
    unitValueUsd: z.number().finite().positive(),
    basketWeights: z
      .array(
        z
          .object({
            assetId: z.string().trim().min(1),
            weight: z.number().finite().positive().max(1),
          })
          .strict(),
      )
      .min(2)
      .max(16)
      .superRefine((weights, ctx) => {
        const assetIds = new Set(weights.map((weight) => weight.assetId));
        if (assetIds.size !== weights.length) {
          ctx.addIssue({ code: "custom", message: "Output basket asset ids must be unique" });
        }
        const total = weights.reduce((sum, weight) => sum + weight.weight, 0);
        if (Math.abs(total - 1) > 0.000001) {
          ctx.addIssue({ code: "custom", message: "Output basket weights must sum to 1" });
        }
      }),
  })
  .strict();

export interface LiveReserveScoringPolicy {
  maxSourceAgeSec?: number;
  allowedDegradedWarningCodes?: string[];
}

export interface LiveReserveDisplay {
  url?: string;
  label?: string;
}

export interface LiveReservesConfig {
  adapter: LiveReserveAdapterKey;
  version: number;
  semantics: LiveReserveSemantics;
  breakerScope?: string;
  display?: LiveReserveDisplay;
  scoring?: LiveReserveScoringPolicy;
  inputs: {
    primary: LiveReserveInput;
    fallbacks?: LiveReserveInput[];
  };
  params?: Record<string, unknown>;
}

export type ReservePresentationMode = "live" | "live-stale" | "curated-fallback" | "template-fallback" | "unavailable";

export interface ReserveSyncStateView {
  enabled: boolean;
  status: "ok" | "degraded" | "error" | "skipped";
  stale: boolean;
  bootstrap: boolean;
  lastAttemptedAt?: number;
  lastSuccessAt?: number;
  warnings?: string[];
  lastError?: string;
  failureCategory?: string;
  uncertainWrite?: boolean;
}

export interface ReserveProvenanceView {
  evidenceClass: LiveReserveEvidenceClass;
  sourceModel: LiveReserveSourceModel;
  freshnessMode?: LiveReserveFreshnessMode;
  scoringEligible: boolean;
}

export interface ReserveDisplayBadgeView {
  kind: ReserveDisplayBadgeKind;
  label: string;
}

export interface StablecoinReservesResponse {
  stablecoinId: string;
  mode: ReservePresentationMode;
  reserves: ReserveSlice[];
  estimated: boolean;
  liveAt?: number;
  source?: string;
  displayUrl?: string;
  evidenceUrls?: string[];
  metadata?: LiveReserveSnapshotMetadata;
  provenance?: ReserveProvenanceView;
  displayBadge?: ReserveDisplayBadgeView;
  sync?: ReserveSyncStateView;
}

const UnknownRecordSchema: z.ZodType<Record<string, unknown>> = z.record(z.string(), z.unknown());

export const ReserveCompositionHistoryWriteGapSchema = z.object({
  stablecoinId: z.string(),
  fetchedAt: z.number(),
  attemptId: z.string(),
  compositionHistoryMissing: z.boolean(),
  attemptHistoryMissing: z.boolean(),
});

export const ReserveCompositionOverviewSchema = z.object({
  configuredCoins: z.number(),
  freshCoins: z.number(),
  staleCoins: z.number(),
  missingCoins: z.number(),
  degradedCoins: z.number(),
  errorCoins: z.number(),
  corruptCoins: z.number(),
  independentFreshEligible: z.number(),
  independentFreshUnverified: z.number(),
  staticValidatedFresh: z.number(),
  weakProbeFresh: z.number(),
  writeTimeoutUncertain: z.number(),
  deferredCoins: z.number(),
  runBudgetTruncated: z.boolean(),
  deferredAt: z.number().nullable(),
  nextCursorStablecoinId: z.string().nullable(),
  cursorTailState: z.enum(["recording", "incomplete", "complete"]).nullable(),
  cursorTailError: z.string().nullable(),
  cursorRecordedAt: z.number().nullable(),
  cursorTailCompletedAt: z.number().nullable(),
  cursorTailFailedAt: z.number().nullable(),
  runBudgetTruncationCount: z.number(),
  historyWriteGaps: z.array(ReserveCompositionHistoryWriteGapSchema),
  /**
   * Coins whose adapter is classified as `independent` but whose latest source
   * has been stuck in `degraded` or `error` with the last successful snapshot
   * older than the live-reserve persistent-stale threshold.
   */
  persistentlyStaleIndependentCoins: z.array(
    z.object({
      stablecoinId: z.string(),
      ageSec: z.number(),
    }),
  ),
  lastSuccessAt: z.number().nullable(),
  oldestFreshAgeSec: z.number().nullable(),
});
export type ReserveCompositionOverview = z.infer<typeof ReserveCompositionOverviewSchema>;

export const LiveReserveRedemptionTelemetrySchema: z.ZodType<LiveReserveRedemptionTelemetry> = z
  .object({
    capacityUsd: z.number().finite().optional(),
    capacityRatioOfSupply: z.number().finite().optional(),
    capacityKind: z.enum(LIVE_RESERVE_REDEMPTION_CAPACITY_KIND_VALUES).optional(),
    freshnessKind: z.enum(LIVE_RESERVE_REDEMPTION_FRESHNESS_KIND_VALUES).optional(),
    sourceTimestamp: z.number().finite().optional(),
    blockNumber: z.number().finite().optional(),
    routeStatus: RedemptionRouteStatusSchema.optional(),
    routeStatusSource: RedemptionRouteStatusSourceSchema.optional(),
    routeStatusReason: z.string().optional(),
    routeStatusReviewedAt: z.string().optional(),
    holderEligibility: RedemptionHolderEligibilitySchema.optional(),
    settlementDelaySec: z.number().finite().optional(),
    queueDepthUsd: z.number().finite().optional(),
    dailyLimitUsd: z.number().finite().optional(),
    minRedeemUsd: z.number().finite().optional(),
    feeBps: z.number().finite().optional(),
    sourceUrls: z.array(HttpUrlSchema).optional(),
    outputValuation: LiveReserveRedemptionOutputValuationSchema.optional(),
  })
  .passthrough();

export const LiveReserveSnapshotMetadataSchema: z.ZodType<LiveReserveSnapshotMetadata> = z
  .object({
    sourceTimestamp: z.number().finite().optional(),
    freshnessMode: z.enum(LIVE_RESERVE_FRESHNESS_MODE_VALUES).optional(),
    scoringAllowsUnverifiedFreshness: z.boolean().optional(),
    unknownExposurePct: z.number().finite().optional(),
    yieldBasisCollateralUsd: z.number().finite().optional(),
    yieldBasisCollateralPct: z.number().finite().optional(),
    supplyUsd: z.number().finite().optional(),
    totalReserveUsd: z.number().finite().optional(),
    totalAssetsUsd: z.number().finite().optional(),
    totalLiabilitiesUsd: z.number().finite().optional(),
    shareholderEquityUsd: z.number().finite().optional(),
    collateralizationRatio: z.number().finite().optional(),
    liquidationCapacityRatio: z.number().finite().nonnegative().optional(),
    immediateRedeemableUsd: z.number().finite().optional(),
    immediateRedeemableRatio: z.number().finite().optional(),
    redemptionFeeBps: z.number().finite().optional(),
    buyFeeBpsMin: z.number().finite().optional(),
    buyFeeBpsMax: z.number().finite().optional(),
    redemption: LiveReserveRedemptionTelemetrySchema.optional(),
    details: UnknownRecordSchema.optional(),
  })
  .passthrough();

export const ReserveProvenanceViewSchema: z.ZodType<ReserveProvenanceView> = z
  .object({
    evidenceClass: z.enum(LIVE_RESERVE_EVIDENCE_CLASS_VALUES),
    sourceModel: z.enum(LIVE_RESERVE_SOURCE_MODEL_VALUES),
    freshnessMode: z.enum(LIVE_RESERVE_FRESHNESS_MODE_VALUES).optional(),
    scoringEligible: z.boolean(),
  })
  .strict();

export const ReserveDisplayBadgeViewSchema: z.ZodType<ReserveDisplayBadgeView> = z
  .object({
    kind: z.enum(RESERVE_DISPLAY_BADGE_KIND_VALUES),
    label: z.string(),
  })
  .strict();

export const ReserveSyncStateViewSchema: z.ZodType<ReserveSyncStateView> = z
  .object({
    enabled: z.boolean(),
    status: z.enum(["ok", "degraded", "error", "skipped"]),
    stale: z.boolean(),
    bootstrap: z.boolean(),
    lastAttemptedAt: z.number().finite().optional(),
    lastSuccessAt: z.number().finite().optional(),
    warnings: z.array(z.string()).optional(),
    lastError: z.string().optional(),
    failureCategory: z.string().optional(),
    uncertainWrite: z.boolean().optional(),
  })
  .strict();

export const StablecoinReservesResponseSchema: z.ZodType<StablecoinReservesResponse> = z
  .object({
    stablecoinId: z.string(),
    mode: z.enum(["live", "live-stale", "curated-fallback", "template-fallback", "unavailable"]),
    reserves: z.array(ReserveSliceSchema),
    estimated: z.boolean(),
    liveAt: z.number().finite().optional(),
    source: z.string().optional(),
    displayUrl: z.string().optional(),
    evidenceUrls: z.array(z.string()).optional(),
    metadata: LiveReserveSnapshotMetadataSchema.optional(),
    provenance: ReserveProvenanceViewSchema.optional(),
    displayBadge: ReserveDisplayBadgeViewSchema.optional(),
    sync: ReserveSyncStateViewSchema.optional(),
  })
  .strict();
