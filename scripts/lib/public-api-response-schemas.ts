import { z } from "zod";

import { PriceConfidenceSchema } from "@shared/types/core";
import { ChainsResponseSchema } from "@shared/types/chains";
import {
  DigestArchiveResponseSchema,
  DigestSnapshotResponseSchema,
  DigestChangeSummarySchema,
  DigestForwardLookOutcomeSchema,
  DigestNextTriggerSchema,
  DigestStandingConditionSchema,
  DigestRiskTapeItemSchema,
} from "@shared/types/digest";
import {
  DdrFrozenDurationSchema,
  DdrOfficialLockOutcomeSchema,
  DdrResolutionSchema,
  DdrResponseSchema,
  DdrV2ResponseRowSchema,
} from "@shared/types/depeg-resolver";
import {
  DdrrResponseSchema,
  DdrrRowSchema,
  DdrrV2SummaryMetricsSchema,
  DdrrV2SummarySegmentSchema,
} from "@shared/types/depeg-resolver-review";
import { StablecoinReservesResponseSchema } from "@shared/types/live-reserves";
import {
  BlacklistResponseSchema,
  BlacklistSummaryResponseSchema,
  BluechipRatingsMapSchema,
  DepegEventsResponseSchema,
  DexLiquidityMapSchema,
  DexLiquidityHistoryResponseSchema,
  NonUsdShareResponseSchema,
  PegSummaryResponseSchema,
  StablecoinChartResponseSchema,
  StablecoinListResponseSchema,
  StressSignalDetailResponseSchema,
  StressSignalsAllResponseSchema,
  SupplyHistoryResponseSchema,
} from "@shared/types/market";
import {
  MintBurnEventsResponseSchema,
  MintBurnFlowsResponseSchema,
  MintBurnPerCoinResponseSchema,
} from "@shared/types/mint-burn";
import { RedemptionBackstopsResponseSchema } from "@shared/types/redemption";
import {
  ReportCardsV9DependencyGraphSchema,
  ReportCardsV9ResponseSchema,
  V9PublicationHealthSchema,
} from "@shared/types/report-cards-v9";
import { SafetyScorePublicationIdentitySchema } from "@shared/types/safety-score-publication";
import {
  SafetyScoreHistoryResponseSchema,
  SafetyScoreHistoryV2ResponseSchema,
} from "@shared/types/safety-score-history";
import { StabilityIndexResponseSchema } from "@shared/types/stability";
import { HealthResponseSchema, PublicStatusHistoryResponseSchema } from "@shared/types/status";
import { TapeEventsResponseSchema } from "@shared/types/tape-event";
import {
  YieldAdapterManifestResponseSchema,
  YieldHistoryResponseSchema,
  YieldPysInputsAtPublishSchema,
  YieldRankingsResponseSchema,
  YieldVenueRiskScoresSchema,
} from "@shared/types/yield";

const PegBucketsSchema = z.record(z.string(), z.number());

const StablecoinDetailTokenSchema = z
  .object({
    totalCirculatingUSD: PegBucketsSchema.optional(),
    totalCirculating: PegBucketsSchema.optional(),
    circulating: PegBucketsSchema.optional(),
  })
  .passthrough();

/** Mirrors the worker-local DefiLlama envelope validator; upstream fields stay passthrough. */
export const StablecoinDetailResponseSchema = z
  .object({
    price: z.number().optional(),
    tokens: z.array(StablecoinDetailTokenSchema).optional(),
  })
  .passthrough();

export const StablecoinSummaryResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  symbol: z.string(),
  pegType: z.string(),
  pegMechanism: z.string(),
  priceUsd: z.number().nullable(),
  priceSource: z.string(),
  priceConfidence: PriceConfidenceSchema.nullable(),
  supplySource: z.string().nullable(),
  supplyObservedAt: z.number().nullable(),
  supplyRestored: z.boolean(),
  supplyByPegUsd: PegBucketsSchema,
  supplyUsd: z.object({
    current: z.number(),
    prevDay: z.number(),
    prevWeek: z.number(),
    prevMonth: z.number(),
    change1d: z.number(),
    change7d: z.number(),
    change30d: z.number(),
  }),
  chainCount: z.number(),
  updatedAt: z.number(),
});

const SnapshotIndexEntrySchema = z.object({
  snapshotDate: z.string(),
  methodologyVersions: z.record(z.string(), z.string()).nullable(),
  safetyScoreIdentity: SafetyScorePublicationIdentitySchema.nullable(),
  contentHash: z.string(),
  byteSize: z.number(),
  createdAt: z.number(),
});

export const SnapshotsIndexResponseSchema = z.object({
  snapshots: z.array(SnapshotIndexEntrySchema),
});

const SnapshotCoinScoreRowSchema = z
  .object({ stablecoinId: z.string() })
  .passthrough()
  .nullable();

export const SnapshotCoinResponseSchema = z.object({
  snapshotDate: z.string(),
  stablecoinId: z.string(),
  generatedAt: z.number(),
  methodologyVersions: z.record(z.string(), z.string()).nullable(),
  safetyScoreIdentity: SafetyScorePublicationIdentitySchema.nullable(),
  // The stored snapshot envelope guarantees the id; remaining stablecoin fields are versioned data.
  stablecoin: z.object({ id: z.string() }).passthrough(),
  scores: z.object({
    reportCard: z.unknown().nullable(),
    psi: z.unknown().nullable(),
    dews: SnapshotCoinScoreRowSchema,
    liquidity: SnapshotCoinScoreRowSchema,
  }),
});

/** Output shape of the worker's normalized USDS status response, without its runtime transform. */
export const UsdsStatusResponseArtifactSchema = z.object({
  implementationAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  freezeCapabilityPresent: z.boolean(),
  lastChecked: z.number(),
});

const DailyDigestRiskSignalArtifactSchema = z.object({
  kind: z.literal("depeg"),
  symbol: z.string(),
  bps: z.number(),
  mcapUsd: z.number().nullable(),
  severity: z.enum(["critical", "watch"]),
  activeCount: z.number().optional(),
  date: z.string().nullable().optional(),
});

/** Output shape of the daily digest endpoint, without its runtime defaulting transform. */
export const DailyDigestResponseArtifactSchema = z.object({
  digest: z.string().nullable(),
  digestTitle: z.string().nullable(),
  digestExtended: z.string().nullable(),
  generatedAt: z.number().nullable(),
  editionNumber: z.number().nullable(),
  riskSignal: DailyDigestRiskSignalArtifactSchema.nullable(),
  changeSummary: DigestChangeSummarySchema.nullable(),
  nextTriggers: z.array(DigestNextTriggerSchema).nullable(),
  forwardLookOutcomes: z.array(DigestForwardLookOutcomeSchema).nullable(),
  riskTape: z.array(DigestRiskTapeItemSchema).nullable(),
  standingConditions: z.array(DigestStandingConditionSchema).nullable(),
});

const TelegramPulsePrivacyArtifactSchema = z.object({
  exactActiveWatchers: z.boolean(),
  lowCardinalityThreshold: z.number(),
  suppressedFields: z.array(z.string()),
});

const TelegramWatcherHistoryPointArtifactSchema = z.object({
  date: z.string(),
  timestamp: z.number(),
  snapshotAt: z.number().nullable().optional(),
  newWatchers: z.number().nullable().optional(),
  activeWatchers: z.number(),
  churnedWatchers: z.number().nullable().optional(),
  reactivatedWatchers: z.number().nullable().optional(),
});

const TelegramTelemetryQualityArtifactSchema = z.object({
  status: z.enum(["complete", "partial"]),
  unavailableFields: z.array(z.string()),
  errors: z.record(z.string(), z.string()).optional(),
});

/** Output shape of Telegram pulse after runtime defaults are applied. */
export const TelegramPulseResponseArtifactSchema = z.object({
  activeWatchers: z.number(),
  coinSubscriptions: z.number(),
  explicitCoinSubscriptions: z.number().optional(),
  presetImpliedCoinSubscriptions: z.number().optional(),
  activePresetFollowers: z.number().optional(),
  newWatchersToday: z.number().nullable().optional(),
  churnedWatchersToday: z.number().nullable().optional(),
  reactivatedWatchersToday: z.number().nullable().optional(),
  historySource: z.enum(["snapshot", "live-fallback"]).optional(),
  topCoins: z.array(z.string()),
  watcherHistory: z.array(TelegramWatcherHistoryPointArtifactSchema),
  pendingDeliveries: z.number().nullable(),
  miniAppSessionsToday: z.number().nullable().optional(),
  miniAppMutationsToday: z.number().nullable().optional(),
  miniAppDeniedToday: z.number().nullable().optional(),
  miniAppReplayClaimsToday: z.number().nullable().optional(),
  miniAppOpenToFirstMutationP50Sec: z.number().nullable().optional(),
  currentSnapshotAt: z.number(),
  lifecycleHistoryUpdatedAt: z.number().nullable(),
  lifecycleHistoryEverySeconds: z.number(),
  quality: TelegramTelemetryQualityArtifactSchema,
  privacy: TelegramPulsePrivacyArtifactSchema,
  updatedAt: z.number(),
  updatedEverySeconds: z.number(),
});

/**
 * Named nested contracts keep the largest response families readable in the
 * generated components section without changing their runtime validators.
 */
export const PUBLIC_API_RESPONSE_COMPONENT_SCHEMAS = {
  DdrFrozenDuration: DdrFrozenDurationSchema,
  DdrOfficialLockOutcome: DdrOfficialLockOutcomeSchema,
  DdrResolution: DdrResolutionSchema,
  DdrV2ResponseRow: DdrV2ResponseRowSchema,
  DdrrRow: DdrrRowSchema,
  DdrrV2SummaryMetrics: DdrrV2SummaryMetricsSchema,
  DdrrV2SummarySegment: DdrrV2SummarySegmentSchema,
  ReportCardsV9DependencyGraph: ReportCardsV9DependencyGraphSchema,
  V9PublicationHealth: V9PublicationHealthSchema,
  YieldPysInputsAtPublish: YieldPysInputsAtPublishSchema,
  YieldVenueRiskScores: YieldVenueRiskScoresSchema,
} as const satisfies Record<string, z.ZodType>;

/**
 * snapshot-day deliberately remains a JsonValue debt entry in the artifact
 * catalog: it is a raw historical V8/V9 producer envelope whose large inline
 * union would be brittle and low-value as a published schema.
 */

export const PUBLIC_API_RESPONSE_SCHEMAS = {
  HealthResponse: HealthResponseSchema,
  StablecoinDetailResponse: StablecoinDetailResponseSchema,
  StablecoinSummaryResponse: StablecoinSummaryResponseSchema,
  NonUsdShareResponse: NonUsdShareResponseSchema,
  SnapshotsIndexResponse: SnapshotsIndexResponseSchema,
  SnapshotCoinResponse: SnapshotCoinResponseSchema,
  StablecoinListResponse: StablecoinListResponseSchema,
  StablecoinReservesResponse: StablecoinReservesResponseSchema,
  StablecoinChartResponse: StablecoinChartResponseSchema,
  PegSummaryResponse: PegSummaryResponseSchema,
  BluechipRatingsResponse: BluechipRatingsMapSchema,
  DexLiquidityResponse: DexLiquidityMapSchema,
  DepegEventsResponse: DepegEventsResponseSchema,
  TapeEventsResponse: TapeEventsResponseSchema,
  UsdsStatusResponse: UsdsStatusResponseArtifactSchema,
  DexLiquidityHistoryResponse: DexLiquidityHistoryResponseSchema,
  ReportCardsV9Response: ReportCardsV9ResponseSchema,
  DdrResponse: DdrResponseSchema,
  DdrrResponse: DdrrResponseSchema,
  RedemptionBackstopsResponse: RedemptionBackstopsResponseSchema,
  StabilityIndexResponse: StabilityIndexResponseSchema,
  BlacklistResponse: BlacklistResponseSchema,
  BlacklistSummaryResponse: BlacklistSummaryResponseSchema,
  StressSignalsResponse: z.union([StressSignalsAllResponseSchema, StressSignalDetailResponseSchema]),
  MintBurnFlowsResponse: z.union([MintBurnFlowsResponseSchema, MintBurnPerCoinResponseSchema]),
  MintBurnEventsResponse: MintBurnEventsResponseSchema,
  YieldRankingsResponse: YieldRankingsResponseSchema,
  YieldAdapterManifestResponse: YieldAdapterManifestResponseSchema,
  YieldHistoryResponse: YieldHistoryResponseSchema,
  ChainsResponse: ChainsResponseSchema,
  SupplyHistoryResponse: SupplyHistoryResponseSchema,
  SafetyScoreHistoryResponse: SafetyScoreHistoryResponseSchema,
  SafetyScoreHistoryV2Response: SafetyScoreHistoryV2ResponseSchema,
  DailyDigestResponse: DailyDigestResponseArtifactSchema,
  DigestArchiveResponse: DigestArchiveResponseSchema,
  DigestSnapshotResponse: DigestSnapshotResponseSchema,
  PublicStatusHistoryResponse: PublicStatusHistoryResponseSchema,
  TelegramPulseResponse: TelegramPulseResponseArtifactSchema,
} as const satisfies Record<string, z.ZodType>;

export type PublicApiResponseSchemaName = keyof typeof PUBLIC_API_RESPONSE_SCHEMAS;
