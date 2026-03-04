"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { API_BASE } from "@/lib/api";
import type { StatusResponse } from "@/lib/types";
import { CRON_1MIN, createPollingQueryOptions } from "./use-api-query";

/**
 * Fetches /api/status with admin key auth.
 * Auto-refreshes every 60s for live ops monitoring.
 */
export function useStatus(adminKey: string): UseQueryResult<StatusResponse, Error> {
  return useQuery<StatusResponse, Error>(createPollingQueryOptions(
    ["status", adminKey],
    async () => {
      const res = await fetch(`${API_BASE}/api/status`, {
        headers: { "X-Admin-Key": adminKey },
      });
      if (!res.ok) {
        if (res.status === 401) throw new Error("Invalid admin key");
        throw new Error(`Failed to fetch status: ${res.status}`);
      }
      return res.json() as Promise<StatusResponse>;
    },
    CRON_1MIN,
    { enabled: !!adminKey, retry: 0 },
  ));
}
