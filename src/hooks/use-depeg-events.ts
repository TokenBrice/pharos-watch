"use client";

import type { DepegEvent } from "@/lib/types";
import { useApiQuery, CRON_5MIN } from "./use-api-query";

interface DepegEventsResponse {
  events: DepegEvent[];
  total: number;
}

export function useDepegEvents(stablecoinId?: string) {
  const params = stablecoinId ? `?stablecoin=${encodeURIComponent(stablecoinId)}` : "";
  return useApiQuery<DepegEventsResponse>(
    ["depeg-events", stablecoinId],
    `/api/depeg-events${params}`,
    CRON_5MIN
  );
}
