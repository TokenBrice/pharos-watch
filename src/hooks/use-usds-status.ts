"use client";

import { useQuery } from "@tanstack/react-query";
import { API_BASE } from "@/lib/api";

interface UsdsStatus {
  freezeActive: boolean;
  implementationAddress: string;
  lastChecked: number;
}

async function fetchUsdsStatus(): Promise<UsdsStatus | null> {
  const res = await fetch(`${API_BASE}/api/usds-status`);
  if (!res.ok) throw new Error("Failed to fetch USDS status");
  return res.json();
}

export function useUsdsStatus() {
  return useQuery({
    queryKey: ["usds-status"],
    queryFn: fetchUsdsStatus,
    // Worker syncs every 15min (syncUsdsStatus); poll at 2x interval
    staleTime: 15 * 60 * 1000,
    refetchInterval: 30 * 60 * 1000,
    retry: 1,
  });
}
