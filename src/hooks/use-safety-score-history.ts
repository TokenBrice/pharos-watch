"use client";

import { SafetyScoreHistoryResponseSchema, type SafetyScoreHistoryResponse } from "@shared/types";
import { useApiQuery, CRON_24H } from "./use-api-query";
import type { ZodType } from "zod";

export function useSafetyScoreHistory(stablecoinId: string, days = 3650) {
  return useApiQuery<SafetyScoreHistoryResponse>(
    ["safety-score-history", stablecoinId, days],
    `/api/safety-score-history?stablecoin=${encodeURIComponent(stablecoinId)}&days=${days}`,
    CRON_24H,
    {
      enabled: !!stablecoinId,
      schema: SafetyScoreHistoryResponseSchema as unknown as ZodType<SafetyScoreHistoryResponse>,
    },
  );
}
