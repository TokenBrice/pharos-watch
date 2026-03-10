"use client";

import type { YieldHistoryPoint } from "@shared/types";
import { useApiQueryWithMeta, CRON_30MIN } from "./use-api-query";

export function useYieldHistory(stablecoinId: string, days = 90) {
  return useApiQueryWithMeta<YieldHistoryPoint[]>(
    ["yield-history", stablecoinId, days],
    `/api/yield-history?stablecoin=${encodeURIComponent(stablecoinId)}&days=${days}`,
    CRON_30MIN,
    { metaMaxAgeSec: 1800 },
  );
}
