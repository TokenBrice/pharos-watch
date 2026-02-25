"use client";

import type { ReportCardsResponse } from "@/lib/types";
import { useApiQuery, CRON_15MIN } from "./use-api-query";

export function useReportCards() {
  return useApiQuery<ReportCardsResponse>(["report-cards"], "/api/report-cards", CRON_15MIN);
}
