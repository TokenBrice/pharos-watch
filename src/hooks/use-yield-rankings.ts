"use client";

import type { YieldRankingsResponse } from "@shared/types";
import { useApiQuery, CRON_30MIN } from "./use-api-query";

export function useYieldRankings() {
  return useApiQuery<YieldRankingsResponse>(
    ["yield-rankings"],
    "/api/yield-rankings",
    CRON_30MIN,
  );
}
