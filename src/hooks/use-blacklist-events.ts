"use client";

import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { BlacklistEvent } from "@/lib/types";
import { CRON_15MIN } from "./use-api-query";

interface BlacklistResponse {
  events: BlacklistEvent[];
  total: number;
}

async function fetchBlacklistEvents(): Promise<BlacklistResponse> {
  const json = await apiFetch<BlacklistResponse | BlacklistEvent[]>("/api/blacklist");

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
    staleTime: CRON_15MIN,
    refetchInterval: 2 * CRON_15MIN,
    retry: 1,
  });
}
