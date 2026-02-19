"use client";

import { useQuery } from "@tanstack/react-query";
import type { BlacklistEvent } from "@/lib/types";
import { API_BASE } from "@/lib/api";

interface BlacklistResponse {
  events: BlacklistEvent[];
  total: number;
}

async function fetchBlacklistEvents(): Promise<BlacklistResponse> {
  const res = await fetch(`${API_BASE}/api/blacklist`);
  if (!res.ok) throw new Error("Failed to fetch blacklist events");
  const json = await res.json();

  // Support both old (plain array) and new ({ events, total }) response format
  if (Array.isArray(json)) {
    return { events: json, total: json.length };
  }
  return json as BlacklistResponse;
}

export function useBlacklistEvents() {
  return useQuery({
    queryKey: ["blacklist-events"],
    queryFn: fetchBlacklistEvents,
    // Worker syncs every 15min; poll at 2x interval
    staleTime: 15 * 60 * 1000,
    refetchInterval: 30 * 60 * 1000,
    retry: 1,
  });
}
