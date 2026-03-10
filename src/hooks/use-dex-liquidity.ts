"use client";

import { DexLiquidityMapSchema, type DexLiquidityMap } from "@shared/types";
import { useApiQueryWithMeta, CRON_30MIN } from "./use-api-query";

export function useDexLiquidity() {
  return useApiQueryWithMeta<DexLiquidityMap>(
    ["dex-liquidity"],
    "/api/dex-liquidity",
    CRON_30MIN,
    { schema: DexLiquidityMapSchema },
  );
}
