"use client";

import { useQuery } from "@tanstack/react-query";
import { API_BASE } from "@/lib/api";

export interface ChartPoint {
  date: number; // unix seconds
  totalCirculatingUSD: Record<string, number>;
}

async function fetchStablecoinCharts(): Promise<ChartPoint[]> {
  const res = await fetch(`${API_BASE}/api/stablecoin-charts`);
  if (!res.ok) throw new Error("Failed to fetch stablecoin charts");
  return res.json();
}

export function useStablecoinCharts() {
  return useQuery({
    queryKey: ["stablecoin-charts"],
    queryFn: fetchStablecoinCharts,
    // Worker syncs every 5min; poll at 2x interval
    staleTime: 5 * 60 * 1000,
    refetchInterval: 10 * 60 * 1000,
  });
}
