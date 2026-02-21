"use client";

import type { PegSummaryResponse } from "@/lib/types";
import { useApiQuery, CRON_15MIN } from "./use-api-query";

export function usePegSummary() {
  return useApiQuery<PegSummaryResponse>(["peg-summary"], "/api/peg-summary", CRON_15MIN);
}
