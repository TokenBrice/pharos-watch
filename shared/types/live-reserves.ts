import { z } from "zod";
import { ReserveObservationEnvelopeSchema, ReserveBoundedFactsGenerationSchema } from "./safety-score-v9-reserve-scope";
import { LIVE_RESERVE_ADAPTER_KEYS, type LiveReserveAdapterKey } from "./live-reserve-adapter-declarations";
import type {
  LiveReserveInput,
  LiveReserveSemantics,
  LiveReserveWarningEffect,
} from "./live-reserve-core";
import {
  LIVE_RESERVE_EVIDENCE_CLASS_VALUES,
  LIVE_RESERVE_FRESHNESS_MODE_VALUES,
  LIVE_RESERVE_SOURCE_MODEL_VALUES,
  RESERVE_DISPLAY_BADGE_KIND_VALUES,
  NativeReserveQuantityBasisSchema,
} from "./live-reserve-core";
import { ReserveSliceSchema } from "./reserves";
import { HttpUrlSchema } from "./validators";
import { isValidIsoDateOnly } from "./date-primitives";
import {
  RedemptionHolderEligibilitySchema,
  RedemptionLiveCapacityKindValues,
  RedemptionLiveFreshnessKindValues,
  RedemptionRouteStatusSchema,
  RedemptionRouteStatusSourceSchema,
} from "./redemption";
import { ReserveFreshnessViewSchema, LiveReserveAdmissionRejectionCodeSchema } from "./reserve-input";
export { ReserveFreshnessViewSchema } from "./reserve-input";
export type { ReserveFreshnessView, LiveReserveAdmissionRejectionCode } from "./reserve-input";

export { LIVE_RESERVE_ADAPTER_KEYS, type LiveReserveAdapterKey };
export * from "./live-reserve-core";

// Pure scopes let bundlers omit unused schema graphs, including nested Zod
// constructor arguments; annotating only the outer call leaves those allocated.

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

export const LiveReserveRedemptionOutputValuationSchema = /* @__PURE__ */ (() => z
  .object({
    sourceId: z.string().trim().min(1),
    observedAt: z.number().int().nonnegative(),
    unitValueUsd: z.number().finite().positive(),
    expectedUnitValueUsd: z.number().finite().positive().optional(),
    basketWeights: z
      .array(
        z
          .object({
            assetId: z.string().trim().min(1),
            weight: z.number().finite().nonnegative().max(1),
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
  .strict())();
export type LiveReserveRedemptionOutputValuation = z.output<typeof LiveReserveRedemptionOutputValuationSchema>;

export interface LiveReserveScoringPolicy {
  maxSourceAgeSec?: number;
  allowedDegradedWarningCodes?: string[];
}

export interface LiveReserveDisplay {
  url?: string;
  label?: string;
}

/**
 * Explicit operator suspension of a live reserve feed. A suspended config is
 * stripped from runtime metadata at registry load, so every consumer (sync
 * queue, scoring, presentation) behaves as if the coin has no live feed and
 * falls back to curated reserve evidence. The source file keeps the full
 * adapter config so re-enabling is a one-line revert.
 */
export interface LiveReserveSuspension {
  reason: string;
  since: string;
  reviewBy?: string;
}

export interface LiveReservesConfig {
  adapter: LiveReserveAdapterKey;
  version: number;
  semantics: LiveReserveSemantics;
  breakerScope?: string;
  display?: LiveReserveDisplay;
  scoring?: LiveReserveScoringPolicy;
  suspended?: LiveReserveSuspension;
  /** One bounded reserve-only prerequisite attempt; never authorizes listing. */
  bootstrapForSupplyAdmission?: { reviewBy: string };
  inputs: {
    primary: LiveReserveInput;
    fallbacks?: LiveReserveInput[];
  };
  params?: Record<string, unknown>;
}

const UnknownRecordSchema: z.ZodType<Record<string, unknown>> = /* @__PURE__ */ (() => z.record(z.string(), z.unknown()))();

export const ReserveSyncAdapterReliabilitySchema = /* @__PURE__ */ (() => z.object({
  adapterKey: z.string(),
  attempts: z.number().int().nonnegative(),
  ok: z.number().int().nonnegative(),
  degraded: z.number().int().nonnegative(),
  error: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  successRate: z.number().finite().nonnegative().max(1).nullable(),
}))();
export type ReserveSyncAdapterReliability = z.infer<typeof ReserveSyncAdapterReliabilitySchema>;

export const ReserveFeedReviewSchema = /* @__PURE__ */ (() => z.object({
  stablecoinId: z.string().min(1),
  adapterKey: z.enum(LIVE_RESERVE_ADAPTER_KEYS),
  failureCategory: z.string().min(1),
  warningCodes: z.array(z.string().min(1)),
  errorPrefix: z.string().min(1).nullable(),
  owner: z.string().trim().min(1),
  reason: z.string().trim().min(1),
  sources: z.array(z.object({
    url: z.string().url().refine((url) => url.startsWith("https://")),
    evidenceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }).strict()).min(1),
  reviewedAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
}).strict())();
export type ReserveFeedReview = z.output<typeof ReserveFeedReviewSchema>;

export const ReserveCompositionOverviewSchema = /* @__PURE__ */ (() => z.object({
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
  cursorRecordedAt: z.number().nullable(),
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
  adapterReliability: z.array(ReserveSyncAdapterReliabilitySchema),
  healthConfiguredCoins: z.number().optional(),
  healthFreshCoins: z.number().optional(),
  healthAuthoritativeFreshCoins: z.number().optional(),
  acknowledgedFeedIds: z.array(z.string()).optional(),
  acknowledgedFeeds: z.array(ReserveFeedReviewSchema).optional(),
  expiredFeedReviewIds: z.array(z.string()).optional(),
  invalidFeedReviewIds: z.array(z.string()).optional(),
  unacknowledgedPersistentlyStaleIndependentCoins: z.array(z.object({
    stablecoinId: z.string(),
    ageSec: z.number(),
  })).optional(),
}))();
export type ReserveCompositionOverview = z.infer<typeof ReserveCompositionOverviewSchema>;

export function emptyReserveCompositionOverview(configuredCoins = 0): ReserveCompositionOverview {
  return {
    configuredCoins,
    freshCoins: 0,
    staleCoins: 0,
    missingCoins: 0,
    degradedCoins: 0,
    errorCoins: 0,
    corruptCoins: 0,
    independentFreshEligible: 0,
    independentFreshUnverified: 0,
    staticValidatedFresh: 0,
    weakProbeFresh: 0,
    writeTimeoutUncertain: 0,
    deferredCoins: 0,
    runBudgetTruncated: false,
    deferredAt: null,
    nextCursorStablecoinId: null,
    cursorRecordedAt: null,
    persistentlyStaleIndependentCoins: [],
    lastSuccessAt: null,
    oldestFreshAgeSec: null,
    adapterReliability: [],
    healthConfiguredCoins: configuredCoins,
    healthFreshCoins: 0,
    healthAuthoritativeFreshCoins: 0,
    acknowledgedFeedIds: [],
    acknowledgedFeeds: [],
    expiredFeedReviewIds: [],
    invalidFeedReviewIds: [],
    unacknowledgedPersistentlyStaleIndependentCoins: [],
  };
}

const NonNegativeFiniteUsdSchema = /* @__PURE__ */ (() => z.number().finite().nonnegative())();
const UnitRatioSchema = /* @__PURE__ */ (() => z.number().finite().min(0).max(1))();
const BoundedFeeBpsSchema = /* @__PURE__ */ (() => z.number().finite().min(0).max(10_000))();
const NonNegativeFiniteSecondsSchema = /* @__PURE__ */ (() => z.number().finite().nonnegative())();


export const LiveReserveRedemptionTelemetrySchema = /* @__PURE__ */ (() => z
  .object({
    capacityUsd: NonNegativeFiniteUsdSchema.optional(),
    capacityRatioOfSupply: UnitRatioSchema.optional(),
    settlementBoundUnproven: z.literal(true).optional(),
    capacityKind: z.enum(LIVE_RESERVE_REDEMPTION_CAPACITY_KIND_VALUES).optional(),
    freshnessKind: z.enum(LIVE_RESERVE_REDEMPTION_FRESHNESS_KIND_VALUES).optional(),
    sourceTimestamp: z.number().finite().nonnegative().optional(),
    blockNumber: z.number().finite().optional(),
    routeStatus: RedemptionRouteStatusSchema.optional(),
    routeStatusSource: RedemptionRouteStatusSourceSchema.optional(),
    routeStatusReason: z.string().optional(),
    routeStatusReviewedAt: z.string().refine(isValidIsoDateOnly, "Expected YYYY-MM-DD").optional(),
    holderEligibility: RedemptionHolderEligibilitySchema.optional(),
    settlementDelaySec: NonNegativeFiniteSecondsSchema.optional(),
    queueDepthUsd: NonNegativeFiniteUsdSchema.optional(),
    dailyLimitUsd: NonNegativeFiniteUsdSchema.optional(),
    minRedeemUsd: NonNegativeFiniteUsdSchema.optional(),
    feeBps: BoundedFeeBpsSchema.optional(),
    sourceUrls: z.array(HttpUrlSchema).optional(),
    // Exact payout identities for this capacity observation, not reserve assets.
    outputAssetKeys: z.array(z.string().trim().min(1)).min(1).max(16).refine(
      (keys) => new Set(keys).size === keys.length,
      "Output asset identities must be unique",
    ).optional(),
    outputValuation: LiveReserveRedemptionOutputValuationSchema.optional(),
  })
  .passthrough())();
export type LiveReserveRedemptionTelemetry = z.output<typeof LiveReserveRedemptionTelemetrySchema>;

/** Known wire fields without the passthrough index signature, for producer projections. */
export type LiveReserveRedemptionTelemetryKnownFields = Pick<
  LiveReserveRedemptionTelemetry,
  keyof typeof LiveReserveRedemptionTelemetrySchema.shape
>;

/** In-memory quarantine signal; inspect before JSON serialization erases symbols. */
export const MALFORMED_REDEMPTION_TELEMETRY = Symbol.for("pharos.malformedRedemptionTelemetry");

export type LiveReserveRedemptionTelemetryIssue = z.ZodIssue;

export type DecodedLiveReserveRedemptionTelemetry =
  | { status: "absent" }
  | { status: "invalid"; issues: readonly LiveReserveRedemptionTelemetryIssue[] }
  | { status: "valid"; telemetry: LiveReserveRedemptionTelemetry };

/** Structural admission only. Evidence, source age and adapter capabilities are separate policies. */
export function decodeLiveReserveRedemptionTelemetry(
  metadata: unknown,
): DecodedLiveReserveRedemptionTelemetry {
  if (metadata == null) return { status: "absent" };
  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    return { status: "invalid", issues: [{ code: "custom", path: [], message: "Invalid metadata root" }] };
  }
  if (!Object.prototype.hasOwnProperty.call(metadata, "redemption")) {
    return { status: "absent" };
  }
  const raw = (metadata as Record<string, unknown>).redemption;
  if (raw === undefined) return { status: "absent" };
  if (raw && typeof raw === "object" &&
    (raw as Record<PropertyKey, unknown>)[MALFORMED_REDEMPTION_TELEMETRY] === true) {
    return { status: "invalid", issues: [{ code: "custom", path: [], message: "Quarantined redemption telemetry" }] };
  }
  const parsed = LiveReserveRedemptionTelemetrySchema.safeParse(raw);
  return parsed.success
    ? { status: "valid", telemetry: parsed.data }
    : { status: "invalid", issues: parsed.error.issues };
}

export const LiveReserveDiagnosticsSchema = /* @__PURE__ */ (() => z.object({
  rawSumDeviation: z.number().finite().nonnegative().optional(),
}).passthrough())();
export type LiveReserveDiagnostics = z.output<typeof LiveReserveDiagnosticsSchema>;

/** Why a supply-comparing adapter withheld its reserve/liability ratio. */
const LIABILITY_RATIO_UNAVAILABLE_REASON_VALUES = [
  "liability-scope-unclassified-chain",
  "included-supply-read-failed",
  "reserve-supply-time-skew",
  "not-comparable",
  "zero-liability-denominator",
  "reserve-supply-temporal-policy-unreviewed",
] as const;
export type LiabilityRatioUnavailableReason = (typeof LIABILITY_RATIO_UNAVAILABLE_REASON_VALUES)[number];

/** Published projection of a reviewed liability perimeter (config `liabilityScope`). */
const LiveReserveLiabilityScopeMetadataSchema = /* @__PURE__ */ (() => z.discriminatedUnion("basis", [
  z.object({
    basis: z.literal("issuer-native-supply"),
    reviewedAt: z.string(),
    evidenceRef: z.string(),
    includedChains: z.array(z.string()),
    excludedChains: z.array(z.object({
      chain: z.string(),
      relation: z.string(),
      backedBy: z.string().optional(),
      reason: z.string(),
    }).passthrough()),
    /** Catalog chains the reviewed scope does not classify; any entry withholds the ratio. */
    unclassifiedChains: z.array(z.string()),
    /** Included chains whose supply read failed, with the failure reason. */
    failedChains: z.array(z.object({ chain: z.string(), reason: z.string() }).passthrough()),
    maxReserveSupplySkewSec: z.number().finite(),
  }).passthrough(),
  z.object({
    basis: z.literal("not-comparable"),
    canonicalChain: z.string(),
    reason: z.string(),
  }).passthrough(),
]))();
export type LiveReserveLiabilityScopeMetadata = z.output<typeof LiveReserveLiabilityScopeMetadataSchema>;

export const LiveReserveSnapshotMetadataSchema = /* @__PURE__ */ (() => z
  .object({
    reserveObservation: ReserveObservationEnvelopeSchema.optional(),
    boundedFactsGeneration: ReserveBoundedFactsGenerationSchema.optional(),
    sourceTimestamp: z.number().finite().optional(),
    freshnessMode: z.enum(LIVE_RESERVE_FRESHNESS_MODE_VALUES).optional(),
    unknownExposurePct: z.number().finite().optional(),
    yieldBasisCollateralUsd: z.number().finite().optional(),
    yieldBasisCollateralPct: z.number().finite().optional(),
    referenceNavUsd: z.number().finite().optional(),
    supplyUsd: z.number().finite().optional(),
    totalReserveUsd: z.number().finite().optional(),
    supplyTokens: z.number().finite().optional(),
    circulatingSupplyTokens: z.number().finite().optional(),
    totalReserveQuantity: z.number().finite().optional(),
    nativeQuantityBasis: NativeReserveQuantityBasisSchema.optional(),
    totalAssetsUsd: z.number().finite().optional(),
    totalLiabilitiesUsd: z.number().finite().optional(),
    shareholderEquityUsd: z.number().finite().optional(),
    collateralizationRatio: z.number().finite().optional(),
    /** Every liability-scope chain was classified and every included supply read succeeded. */
    supplyCoverageComplete: z.boolean().optional(),
    liabilityScope: LiveReserveLiabilityScopeMetadataSchema.optional(),
    /** Liability-coverage or time-identity reason a supply-comparing adapter withheld `collateralizationRatio`
     *  (issuer-circulation probe failures carry their own warnings instead). */
    ratioUnavailableReason: z.enum(LIABILITY_RATIO_UNAVAILABLE_REASON_VALUES).optional(),
    /** Unix seconds of the reserve observation the ratio numerator describes. */
    reserveObservedAt: z.number().finite().optional(),
    /** Earliest and latest unix-second observation times of the included supply reads. */
    supplyObservedAt: z.object({ min: z.number().finite(), max: z.number().finite() }).optional(),
    /** Largest absolute gap between `reserveObservedAt` and any included supply read. */
    ratioSkewSec: z.number().finite().nonnegative().optional(),
    /** Absent on retained legacy snapshots: unknown, not coin-exclusive. */
    balanceSheetScope: z.literal("shared-sky-maker").optional(),
    sharedBookAssetIds: z.array(z.string().min(1)).optional(),
    sharedBookMeasuredHoldings: z.record(z.string(), z.number().finite().nonnegative()).optional(),
    reconciliationExcessUsd: z.number().finite().nonnegative().optional(),
    reconciliationExcessShare: z.number().finite().nonnegative().optional(),
    reconciliationIssue: z.literal("litepsm-reconciliation-excess").optional(),
    liquidationCapacityRatio: z.number().finite().nonnegative().optional(),
    /**
     * Legacy flat redemption-telemetry fields, superseded by the nested
     * `redemption.capacityUsd` / `redemption.capacityRatioOfSupply` /
     * `redemption.feeBps` contract. Historical D1 rows can still carry them
     * (30-day retention), so they remain optional for read compatibility; the
     * store-row decoder maps them into the nested shape at decode time and no
     * producer writes them anymore.
     *
     * @deprecated Read-only legacy compatibility; use `redemption.*`.
     */
    immediateRedeemableUsd: z.number().finite().optional(),
    immediateRedeemableRatio: z.number().finite().optional(),
    redemptionFeeBps: z.number().finite().optional(),
    buyFeeBpsMin: z.number().finite().optional(),
    buyFeeBpsMax: z.number().finite().optional(),
    redemption: LiveReserveRedemptionTelemetrySchema.optional(),
    details: UnknownRecordSchema.optional(),
    diag: LiveReserveDiagnosticsSchema.optional(),
  })
  .passthrough())();
export type LiveReserveSnapshotMetadata = z.output<typeof LiveReserveSnapshotMetadataSchema>;



export const ReserveProvenanceViewSchema = /* @__PURE__ */ (() => z
  .object({
    evidenceClass: z.enum(LIVE_RESERVE_EVIDENCE_CLASS_VALUES),
    sourceModel: z.enum(LIVE_RESERVE_SOURCE_MODEL_VALUES),
    freshnessMode: z.enum(LIVE_RESERVE_FRESHNESS_MODE_VALUES).optional(),
    scoringEligible: z.boolean(),
    /** Admission reasons behind `scoringEligible` (empty when eligible); `stale` is explained by `sync.freshness`. */
    scoringRejectionReasons: z.array(LiveReserveAdmissionRejectionCodeSchema).optional(),
  })
  .strict())();
export type ReserveProvenanceView = z.output<typeof ReserveProvenanceViewSchema>;

export const ReserveDisplayBadgeViewSchema = /* @__PURE__ */ (() => z
  .object({
    kind: z.enum(RESERVE_DISPLAY_BADGE_KIND_VALUES),
    label: z.string(),
  })
  .strict())();
export type ReserveDisplayBadgeView = z.output<typeof ReserveDisplayBadgeViewSchema>;

export const ReserveCollectionEligibilitySchema = /* @__PURE__ */ (() => z.object({
  scheduled: z.boolean(),
  reason: z.enum(["active", "quarantined", "frozen", "delisted"]),
}).strict())();
export type ReserveCollectionEligibility = z.output<typeof ReserveCollectionEligibilitySchema>;

export const ReserveSyncStateViewSchema = /* @__PURE__ */ (() => z
  .object({
    enabled: z.boolean(),
    status: z.enum(["ok", "degraded", "error", "skipped"]),
    stale: z.boolean(),
    bootstrap: z.boolean(),
    collectionEligibility: ReserveCollectionEligibilitySchema.optional(),
    lastAttemptedAt: z.number().finite().optional(),
    lastSuccessAt: z.number().finite().optional(),
    warnings: z.array(z.string()).optional(),
    lastError: z.string().optional(),
    failureCategory: z.string().optional(),
    uncertainWrite: z.boolean().optional(),
    /** Budgets, clock, and generation behind `stale`; absent only from producers predating ADR-30 publication. */
    freshness: ReserveFreshnessViewSchema.optional(),
    acknowledgedFeed: ReserveFeedReviewSchema.optional(),
  })
  .strict())();
export type ReserveSyncStateView = z.output<typeof ReserveSyncStateViewSchema>;

export const StablecoinReservesResponseSchema = /* @__PURE__ */ (() => z
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
  .strict())();
export type StablecoinReservesResponse = z.output<typeof StablecoinReservesResponseSchema>;
export type ReservePresentationMode = StablecoinReservesResponse["mode"];
