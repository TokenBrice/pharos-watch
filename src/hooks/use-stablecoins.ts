"use client";

import { useQuery } from "@tanstack/react-query";
import type { StablecoinListResponse } from "@/lib/types";
import { API_BASE } from "@/lib/api";

async function fetchStablecoins(): Promise<StablecoinListResponse> {
  const res = await fetch(`${API_BASE}/api/stablecoins`);
  if (!res.ok) throw new Error("Failed to fetch stablecoins");
  return res.json();
}

export function useStablecoins() {
  return useQuery({
    queryKey: ["stablecoins"],
    queryFn: fetchStablecoins,
    // Worker syncs every 5min; poll at 2x interval
    staleTime: 5 * 60 * 1000,
    refetchInterval: 10 * 60 * 1000,
  });
}

async function fetchStablecoinDetail(id: string) {
  const res = await fetch(`${API_BASE}/api/stablecoin/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`Failed to fetch stablecoin ${id}`);
  return res.json();
}

export function useStablecoinDetail(id: string) {
  return useQuery({
    queryKey: ["stablecoin", id],
    queryFn: () => fetchStablecoinDetail(id),
    enabled: !!id,
    // Worker syncs every 5min; poll at 2x interval
    staleTime: 5 * 60 * 1000,
    refetchInterval: 10 * 60 * 1000,
  });
}
