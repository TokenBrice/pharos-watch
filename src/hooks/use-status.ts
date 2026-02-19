"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { API_BASE } from "@/lib/api";
import type { StatusResponse } from "@/lib/types";

/**
 * Fetches /api/status with admin key auth.
 * No auto-refetch — manual refresh only (admin page).
 */
export function useStatus(adminKey: string): UseQueryResult<StatusResponse, Error> {
  return useQuery<StatusResponse, Error>({
    queryKey: ["status", adminKey],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/status`, {
        headers: { "X-Admin-Key": adminKey },
      });
      if (!res.ok) {
        if (res.status === 401) throw new Error("Invalid admin key");
        throw new Error(`Failed to fetch status: ${res.status}`);
      }
      return res.json();
    },
    enabled: !!adminKey,
    staleTime: Infinity,
    retry: 0,
  });
}
