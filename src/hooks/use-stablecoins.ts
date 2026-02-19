"use client";

import type { StablecoinListResponse } from "@/lib/types";
import { useApiQuery, CRON_5MIN } from "./use-api-query";

export function useStablecoins() {
  return useApiQuery<StablecoinListResponse>(["stablecoins"], "/api/stablecoins", CRON_5MIN);
}

export function useStablecoinDetail(id: string) {
  return useApiQuery<{ tokens?: Record<string, unknown>[] }>(
    ["stablecoin", id],
    `/api/stablecoin/${encodeURIComponent(id)}`,
    CRON_5MIN,
    { enabled: !!id }
  );
}
