"use client";

import { DexLiquidityMapSchema, type DexLiquidityMap } from "@/lib/types";
import { useApiQuery, CRON_30MIN } from "./use-api-query";

export function useDexLiquidity() {
  return useApiQuery<DexLiquidityMap>(
    ["dex-liquidity"],
    "/api/dex-liquidity",
    CRON_30MIN,
    { schema: DexLiquidityMapSchema },
  );
}
