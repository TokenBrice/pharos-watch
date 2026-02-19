"use client";

import { useQuery } from "@tanstack/react-query";
import type { DepegEvent } from "@/lib/types";
import { API_BASE } from "@/lib/api";

interface DepegEventsResponse {
  events: DepegEvent[];
  total: number;
}

async function fetchDepegEvents(stablecoinId?: string): Promise<DepegEventsResponse> {
  const params = new URLSearchParams();
  if (stablecoinId) params.set("stablecoin", stablecoinId);
  const res = await fetch(`${API_BASE}/api/depeg-events?${params}`);
  if (!res.ok) throw new Error("Failed to fetch depeg events");
  return res.json() as Promise<DepegEventsResponse>;
}

export function useDepegEvents(stablecoinId?: string) {
  return useQuery({
    queryKey: ["depeg-events", stablecoinId],
    queryFn: () => fetchDepegEvents(stablecoinId),
    // Depeg detection runs during syncStablecoins (every 5min); poll at 2x interval
    staleTime: 5 * 60 * 1000,
    refetchInterval: 10 * 60 * 1000,
    retry: 1,
  });
}
