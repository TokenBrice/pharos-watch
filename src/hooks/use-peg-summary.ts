"use client";

import { useQuery } from "@tanstack/react-query";
import type { PegSummaryResponse } from "@/lib/types";
import { API_BASE } from "@/lib/api";

async function fetchPegSummary(): Promise<PegSummaryResponse> {
  const res = await fetch(`${API_BASE}/api/peg-summary`);
  if (!res.ok) throw new Error("Failed to fetch peg summary");
  return res.json() as Promise<PegSummaryResponse>;
}

export function usePegSummary() {
  return useQuery({
    queryKey: ["peg-summary"],
    queryFn: fetchPegSummary,
    // Depeg detection runs during syncStablecoins (every 5min); poll at 2x interval
    staleTime: 5 * 60 * 1000,
    refetchInterval: 10 * 60 * 1000,
    retry: 1,
  });
}
