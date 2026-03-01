"use client";

import type { YieldRankingsResponse } from "@/lib/types";
import { useApiQuery, CRON_20MIN } from "./use-api-query";

export function useYieldRankings() {
  return useApiQuery<YieldRankingsResponse>(
    ["yield-rankings"],
    "/api/yield-rankings",
    CRON_20MIN,
  );
}
