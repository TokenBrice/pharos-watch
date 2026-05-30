"use client";

import { useQuery } from "@tanstack/react-query";
import { getPollingWindow } from "@/hooks/use-api-query";
import { fetchLightApiJson } from "@/lib/light-api-client";
import {
  FRONTEND_API_QUERY_REGISTRY,
  type FrontendApiQueryDescriptor,
} from "@/lib/api-query-registry";
import type {
  BlacklistSummaryResponse,
  DailyDigestResponse,
  HealthResponse,
  PegSummaryResponse,
  StabilityIndexResponse,
} from "@shared/types";

function useLightApiQuery<T>(descriptor: FrontendApiQueryDescriptor<T>, enabled = true) {
  const { staleTime, refetchInterval } = getPollingWindow(descriptor.producerIntervalMs);
  return useQuery({
    queryKey: ["api", ...descriptor.queryKey],
    queryFn: () => fetchLightApiJson(descriptor),
    enabled,
    staleTime,
    refetchInterval,
    retry: 1,
  });
}

export function useSidebarPegSummarySignal() {
  return useLightApiQuery<PegSummaryResponse>(FRONTEND_API_QUERY_REGISTRY.pegSummary);
}

export function useSidebarStabilityIndexSignal() {
  return useLightApiQuery<StabilityIndexResponse>(FRONTEND_API_QUERY_REGISTRY.stabilityIndex);
}

export function useSidebarBlacklistSignal(enabled: boolean) {
  return useLightApiQuery<BlacklistSummaryResponse>(
    FRONTEND_API_QUERY_REGISTRY.blacklistSummary,
    enabled,
  );
}

export function useSidebarHealthSignal() {
  return useLightApiQuery<HealthResponse>(FRONTEND_API_QUERY_REGISTRY.health);
}

export function useSidebarDailyDigestSignal() {
  return useLightApiQuery<DailyDigestResponse>(FRONTEND_API_QUERY_REGISTRY.dailyDigest);
}
