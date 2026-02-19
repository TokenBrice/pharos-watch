"use client";

import type { PegSummaryResponse } from "@/lib/types";
import { useApiQuery, CRON_5MIN } from "./use-api-query";

export function usePegSummary() {
  return useApiQuery<PegSummaryResponse>(["peg-summary"], "/api/peg-summary", CRON_5MIN);
}
