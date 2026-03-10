"use client";

import type { YieldRankingsResponse } from "@shared/types";
import { useApiQueryWithMeta, CRON_30MIN } from "./use-api-query";

export function useYieldRankings() {
  return useApiQueryWithMeta<YieldRankingsResponse>(
    ["yield-rankings"],
    "/api/yield-rankings",
    CRON_30MIN,
    { metaMaxAgeSec: 1800 },
  );
}
