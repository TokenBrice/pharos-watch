"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { API_BASE } from "@/lib/api";
import type { HealthResponse } from "@/lib/types";

/**
 * Fetches /api/health (public endpoint, no auth).
 * Auto-refreshes every 60s for live ops monitoring.
 */
export function useHealth(): UseQueryResult<HealthResponse, Error> {
  return useQuery<HealthResponse, Error>({
    queryKey: ["health"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/health`);
      if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
      return res.json() as Promise<HealthResponse>;
    },
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: 1,
  });
}
