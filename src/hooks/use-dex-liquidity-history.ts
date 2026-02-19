"use client";

import type { DexLiquidityHistoryPoint } from "@/lib/types";
import { useApiQuery, CRON_1H } from "./use-api-query";

export function useDexLiquidityHistory(stablecoinId: string, days = 90) {
  return useApiQuery<DexLiquidityHistoryPoint[]>(
    ["dex-liquidity-history", stablecoinId, days],
    `/api/dex-liquidity-history?stablecoin=${encodeURIComponent(stablecoinId)}&days=${days}`,
    CRON_1H
  );
}
