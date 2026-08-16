import { z } from "zod";

import { PriceConfidenceSchema } from "@shared/types/core";
import { ChainsResponseSchema } from "@shared/types/chains";
import {
  DailyDigestResponseSchema,
  DigestArchiveResponseSchema,
  DigestSnapshotResponseSchema,
} from "@shared/types/digest";
import { DdrrResponseSchema } from "@shared/types/depeg-resolver-review";
import { DdrResponseSchema } from "@shared/types/depeg-resolver";
import { StablecoinReservesResponseSchema } from "@shared/types/live-reserves";
import {
  BlacklistResponseSchema,
  BlacklistSummaryResponseSchema,
  BluechipRatingsMapSchema,
  DepegEventsResponseSchema,
  DexLiquidityMapSchema,
  DexLiquidityHistoryResponseSchema,
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
import { ReportCardsV9ResponseSchema } from "@shared/types/report-cards-v9";
import { SafetyScorePublicationIdentitySchema } from "@shared/types/safety-score-publication";
import {
  SafetyScoreHistoryResponseSchema,
  SafetyScoreHistoryV2ResponseSchema,
} from "@shared/types/safety-score-history";
import { StabilityIndexResponseSchema, UsdsStatusResponseSchema } from "@shared/types/stability";
import {
  HealthResponseSchema,
  PublicStatusHistoryResponseSchema,
  TelegramPulseSchema,
} from "@shared/types/status";
import { TapeEventsResponseSchema } from "@shared/types/tape-event";
import {
  YieldAdapterManifestResponseSchema,
  YieldHistoryResponseSchema,
  YieldRankingsResponseSchema,
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

const NonUsdSharePointSchema = z.object({
  date: z.number(),
  // Preserve the frontend contract's nullable aggregate/share fields; total is emitted only when positive.
  commodityShare: z.number().nullable(),
  fiatNonUsdShare: z.number().nullable(),
  commodity: z.number().nullable(),
  fiatNonUsd: z.number().nullable(),
  total: z.number(),
});

export const NonUsdShareResponseSchema = z.array(NonUsdSharePointSchema);

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
  UsdsStatusResponse: UsdsStatusResponseSchema,
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
  DailyDigestResponse: DailyDigestResponseSchema,
  DigestArchiveResponse: DigestArchiveResponseSchema,
  DigestSnapshotResponse: DigestSnapshotResponseSchema,
  PublicStatusHistoryResponse: PublicStatusHistoryResponseSchema,
  TelegramPulseResponse: TelegramPulseSchema,
} as const satisfies Record<string, z.ZodType>;

export type PublicApiResponseSchemaName = keyof typeof PUBLIC_API_RESPONSE_SCHEMAS;
