"use client";

import { useApiQuery, CRON_15MIN } from "./use-api-query";

interface SignalDetail {
  value: number;
  available: boolean;
  [key: string]: unknown;
}

export interface StressSignalEntry {
  score: number;
  band: string;
  signals: Record<string, SignalDetail>;
  computedAt: number;
}

interface StressSignalsAllResponse {
  signals: Record<string, StressSignalEntry>;
  updatedAt: number;
}

interface StressSignalHistoryEntry {
  date: number;
  score: number;
  band: string;
  signals: Record<string, SignalDetail>;
}

interface StressSignalDetailResponse {
  current: StressSignalEntry | null;
  history: StressSignalHistoryEntry[];
}

export function useStressSignals() {
  return useApiQuery<StressSignalsAllResponse>(
    ["stress-signals"],
    "/api/stress-signals",
    CRON_15MIN,
  );
}

export function useStressSignalDetail(stablecoinId: string, days = 30) {
  return useApiQuery<StressSignalDetailResponse>(
    ["stress-signals", stablecoinId, days],
    `/api/stress-signals?stablecoin=${stablecoinId}&days=${days}`,
    CRON_15MIN,
    { enabled: !!stablecoinId },
  );
}
