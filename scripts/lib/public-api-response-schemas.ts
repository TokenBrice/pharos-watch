import type { z } from "zod";

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
  DepegEventsResponseSchema,
  DexLiquidityHistoryResponseSchema,
  PegSummaryResponseSchema,
  StablecoinChartResponseSchema,
  StablecoinListResponseSchema,
  SupplyHistoryResponseSchema,
} from "@shared/types/market";
import { MintBurnEventsResponseSchema } from "@shared/types/mint-burn";
import { RedemptionBackstopsResponseSchema } from "@shared/types/redemption";
import { ReportCardsV9ResponseSchema } from "@shared/types/report-cards-v9";
import {
  SafetyScoreHistoryResponseSchema,
  SafetyScoreHistoryV2ResponseSchema,
} from "@shared/types/safety-score-history";
import { StabilityIndexResponseSchema, UsdsStatusResponseSchema } from "@shared/types/stability";
import { HealthResponseSchema, PublicStatusHistoryResponseSchema } from "@shared/types/status";
import { TapeEventsResponseSchema } from "@shared/types/tape-event";
import {
  YieldAdapterManifestResponseSchema,
  YieldHistoryResponseSchema,
  YieldRankingsResponseSchema,
} from "@shared/types/yield";

export const PUBLIC_API_RESPONSE_SCHEMAS = {
  HealthResponse: HealthResponseSchema,
  StablecoinListResponse: StablecoinListResponseSchema,
  StablecoinReservesResponse: StablecoinReservesResponseSchema,
  StablecoinChartResponse: StablecoinChartResponseSchema,
  PegSummaryResponse: PegSummaryResponseSchema,
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
} as const satisfies Record<string, z.ZodType>;

export type PublicApiResponseSchemaName = keyof typeof PUBLIC_API_RESPONSE_SCHEMAS;
