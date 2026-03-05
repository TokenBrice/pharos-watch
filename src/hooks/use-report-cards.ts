"use client";

import { ReportCardsResponseSchema, type ReportCardsResponse } from "@shared/types";
import { useApiQuery, CRON_15MIN } from "./use-api-query";
import type { ZodType } from "zod";

export function useReportCards() {
  return useApiQuery<ReportCardsResponse>(
    ["report-cards"],
    "/api/report-cards",
    CRON_15MIN,
    { schema: ReportCardsResponseSchema as unknown as ZodType<ReportCardsResponse> },
  );
}
