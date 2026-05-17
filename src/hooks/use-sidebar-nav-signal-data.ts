"use client";

import { useQuery } from "@tanstack/react-query";
import { API_PATHS } from "@shared/lib/api-endpoints";
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
  return useLightApiQuery<PegSummaryResponse>("peg-summary", API_PATHS.pegSummary(), CRON_15MIN);
}

export function useSidebarStabilityIndexSignal() {
  return useLightApiQuery<StabilityIndexResponse>("stability-index", API_PATHS.stabilityIndex(), CRON_30MIN);
}

export function useSidebarBlacklistSignal(enabled: boolean) {
  return useLightApiQuery<BlacklistSummaryResponse>(
    "blacklist-summary",
    API_PATHS.blacklistSummary(),
    CRON_BLACKLIST,
    enabled,
  );
}

export function useSidebarHealthSignal() {
  return useLightApiQuery<HealthResponse>("health", API_PATHS.health(), CRON_1MIN);
}

export function useSidebarDailyDigestSignal() {
  return useLightApiQuery<DailyDigestResponse>("daily-digest", API_PATHS.dailyDigest(), CRON_24H);
}
