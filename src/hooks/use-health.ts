"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import type { HealthResponse } from "@shared/types";
import { CRON_1MIN, useApiQuery } from "./use-api-query";

/**
 * Fetches /api/health (public endpoint, no auth).
 * Auto-refreshes every 60s for live ops monitoring.
 */
export function useHealth(): UseQueryResult<HealthResponse, Error> {
  return useApiQuery<HealthResponse>(
    ["health"],
    "/api/health",
    CRON_1MIN,
    { retry: 1 },
  );
}
