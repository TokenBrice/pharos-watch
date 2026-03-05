"use client";

import { DepegEventsResponseSchema, type DepegEventsResponse } from "@shared/types";
import { useApiQuery, CRON_15MIN } from "./use-api-query";

export function useDepegEvents(stablecoinId?: string) {
  const params = stablecoinId ? `?stablecoin=${encodeURIComponent(stablecoinId)}` : "";
  return useApiQuery<DepegEventsResponse>(
    ["depeg-events", stablecoinId],
    `/api/depeg-events${params}`,
    CRON_15MIN,
    { schema: DepegEventsResponseSchema },
  );
}
