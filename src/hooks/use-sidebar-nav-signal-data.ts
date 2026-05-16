"use client";

import { useQuery } from "@tanstack/react-query";
import { CRON_15MIN, CRON_24H, CRON_30MIN, CRON_BLACKLIST, CRON_1MIN } from "@/lib/cron-intervals";
import { getPollingWindow } from "@/hooks/use-api-query";
import { fetchLightApiJson } from "@/lib/light-api-client";
import type {
  BlacklistSummaryResponse,
  DailyDigestResponse,
  HealthResponse,
  PegSummaryResponse,
  StabilityIndexResponse,
} from "@shared/types";

const PATHS = {
  pegSummary: "/api/peg-summary",
  stabilityIndex: "/api/stability-index",
  blacklistSummary: "/api/blacklist-summary",
  health: "/api/health",
  dailyDigest: "/api/daily-digest",
} as const;

function useLightApiQuery<T>(key: string, path: string, intervalMs: number, enabled = true) {
  const { staleTime, refetchInterval } = getPollingWindow(intervalMs);
  return useQuery({
    queryKey: ["api", key],
    queryFn: () => fetchLightApiJson<T>(path),
    enabled,
    staleTime,
    refetchInterval,
    retry: 1,
  });
}

export function useSidebarPegSummarySignal() {
  return useLightApiQuery<PegSummaryResponse>("peg-summary", PATHS.pegSummary, CRON_15MIN);
}

export function useSidebarStabilityIndexSignal() {
  return useLightApiQuery<StabilityIndexResponse>("stability-index", PATHS.stabilityIndex, CRON_30MIN);
}

export function useSidebarBlacklistSignal(enabled: boolean) {
  return useLightApiQuery<BlacklistSummaryResponse>(
    "blacklist-summary",
    PATHS.blacklistSummary,
    CRON_BLACKLIST,
    enabled,
  );
}

export function useSidebarHealthSignal() {
  return useLightApiQuery<HealthResponse>("health", PATHS.health, CRON_1MIN);
}

export function useSidebarDailyDigestSignal() {
  return useLightApiQuery<DailyDigestResponse>("daily-digest", PATHS.dailyDigest, CRON_24H);
}
