"use client";

import type { StablecoinListResponse } from "@/lib/types";
import { useApiQuery, CRON_5MIN, CRON_1H } from "./use-api-query";

export interface SupplyHistoryPoint {
  date: number;
  circulatingUsd: number;
  price: number | null;
}

export function useStablecoins() {
  return useApiQuery<StablecoinListResponse>(["stablecoins"], "/api/stablecoins", CRON_5MIN);
}

export function useSupplyHistory(id: string) {
  return useApiQuery<SupplyHistoryPoint[]>(
    ["supply-history", id],
    `/api/supply-history?stablecoin=${encodeURIComponent(id)}&days=1825`,
    CRON_1H,
    { enabled: !!id }
  );
}
