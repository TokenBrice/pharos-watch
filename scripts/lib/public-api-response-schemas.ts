import type { z } from "zod";

import { ReportCardsV9ResponseSchema } from "@shared/types/report-cards-v9";
import {
  YieldAdapterManifestResponseSchema,
  YieldHistoryResponseSchema,
  YieldRankingsResponseSchema,
} from "@shared/types/yield";

export const PUBLIC_API_RESPONSE_SCHEMAS = {
  ReportCardsV9Response: ReportCardsV9ResponseSchema,
  YieldRankingsResponse: YieldRankingsResponseSchema,
  YieldAdapterManifestResponse: YieldAdapterManifestResponseSchema,
  YieldHistoryResponse: YieldHistoryResponseSchema,
} as const satisfies Record<string, z.ZodType>;

export type PublicApiResponseSchemaName = keyof typeof PUBLIC_API_RESPONSE_SCHEMAS;
