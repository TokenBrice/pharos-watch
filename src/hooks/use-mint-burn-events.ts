"use client";

import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { MintBurnEvent } from "@/lib/types";

const CRON_2H = 2 * 60 * 60_000;

interface MintBurnResponse {
  events: MintBurnEvent[];
  total: number;
}

async function fetchMintBurnEvents(): Promise<MintBurnResponse> {
  return apiFetch<MintBurnResponse>("/api/mint-burn");
}

export function useMintBurnEvents() {
  return useQuery({
    queryKey: ["mint-burn-events"],
    queryFn: fetchMintBurnEvents,
    staleTime: CRON_2H,
    refetchInterval: 2 * CRON_2H,
    retry: 1,
  });
}
