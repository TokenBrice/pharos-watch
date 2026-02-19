"use client";

import { useQuery } from "@tanstack/react-query";
import { API_BASE } from "@/lib/api";
import type { BluechipRatingsMap } from "@/lib/types";

async function fetchBluechipRatings(): Promise<BluechipRatingsMap | null> {
  const res = await fetch(`${API_BASE}/api/bluechip-ratings`);
  if (!res.ok) throw new Error("Failed to fetch Bluechip ratings");
  return res.json();
}

export function useBluechipRatings() {
  return useQuery({
    queryKey: ["bluechip-ratings"],
    queryFn: fetchBluechipRatings,
    // Worker syncs every 2h; poll at 2x interval
    staleTime: 2 * 60 * 60 * 1000,
    refetchInterval: 4 * 60 * 60 * 1000,
    retry: 1,
  });
}
