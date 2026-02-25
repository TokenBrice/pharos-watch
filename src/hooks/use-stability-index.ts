"use client";

import { useApiQuery, CRON_24H } from "@/hooks/use-api-query";

interface StabilityIndexComponents {
  severity: number;
  breadth: number;
  freezes: number;
  trend: number;
}

interface StabilityIndexCurrent {
  score: number;
  band: string;
  components: StabilityIndexComponents;
  computedAt: number;
}

interface StabilityIndexHistoryPoint {
  date: number;
  score: number;
  band: string;
}

export interface StabilityIndexData {
  current: StabilityIndexCurrent | null;
  history: StabilityIndexHistoryPoint[];
}

export function useStabilityIndex() {
  return useApiQuery<StabilityIndexData>(
    ["stability-index"],
    "/api/stability-index",
    CRON_24H,
  );
}
