"use client";

import { PegSummaryResponseSchema, type PegSummaryResponse } from "@shared/types";
import { useApiQueryWithMeta, CRON_15MIN } from "./use-api-query";

export function usePegSummary() {
  return useApiQueryWithMeta<PegSummaryResponse>(
    ["peg-summary"], "/api/peg-summary", CRON_15MIN,
    { schema: PegSummaryResponseSchema },
  );
}
