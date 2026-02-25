"use client";

import type { DexLiquidityMap } from "@/lib/types";
import { useApiQuery, CRON_20MIN } from "./use-api-query";

export function useDexLiquidity() {
  return useApiQuery<DexLiquidityMap>(["dex-liquidity"], "/api/dex-liquidity", CRON_20MIN);
}
