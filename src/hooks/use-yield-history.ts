"use client";

import type { YieldHistoryPoint } from "@/lib/types";
import { useApiQuery, CRON_1H } from "./use-api-query";

export function useYieldHistory(stablecoinId: string, days = 90) {
  return useApiQuery<YieldHistoryPoint[]>(
    ["yield-history", stablecoinId, days],
    `/api/yield-history?stablecoin=${encodeURIComponent(stablecoinId)}&days=${days}`,
    CRON_1H,
  );
}
