"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { API_BASE } from "@/lib/api";
import type { HealthResponse } from "@shared/types";
import { CRON_1MIN, createPollingQueryOptions } from "./use-api-query";

/**
 * Fetches /api/health (public endpoint, no auth).
 * Auto-refreshes every 60s for live ops monitoring.
 */
export function useHealth(): UseQueryResult<HealthResponse, Error> {
  return useQuery<HealthResponse, Error>(createPollingQueryOptions(
    ["health"],
    async () => {
      const res = await fetch(`${API_BASE}/api/health`);
      if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
      return res.json() as Promise<HealthResponse>;
    },
    CRON_1MIN,
    { retry: 1 },
  ));
}
