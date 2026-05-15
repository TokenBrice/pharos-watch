"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchLightApiJson } from "@/lib/light-api-client";
import { getPollingWindow } from "@/hooks/use-api-query";
import { CRON_30MIN } from "@/lib/cron-intervals";

const STABILITY_INDEX_PATH = "/api/stability-index";

interface StabilityIndexCurrent {
  score: number;
  band: string;
  avg24h?: number;
  avg24hBand?: string;
  computedAt: number;
  components: {
    severity: number;
    breadth: number;
    stressBreadth?: number;
    trend: number;
  };
}

interface StabilityIndexHistoryPoint {
  date: number;
  score: number;
  band: string;
}

export interface StabilityIndexLightResponse {
  current?: StabilityIndexCurrent | null;
  history?: StabilityIndexHistoryPoint[];
}

export function useStabilityIndexLight() {
  const { staleTime, refetchInterval } = getPollingWindow(CRON_30MIN);
  return useQuery({
    queryKey: ["api", STABILITY_INDEX_PATH],
    queryFn: () => fetchLightApiJson<StabilityIndexLightResponse>(STABILITY_INDEX_PATH),
    staleTime,
    refetchInterval,
  });
}
