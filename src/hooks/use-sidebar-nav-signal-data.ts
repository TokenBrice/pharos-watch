"use client";

import { useQuery } from "@tanstack/react-query";
import { getPollingWindow } from "@/hooks/use-api-query";
import { fetchLightApiJson } from "@/lib/light-api-client";
import {
  FRONTEND_API_QUERY_RUNTIME_REGISTRY,
  type FrontendApiQueryDescriptor,
} from "@/lib/api-query-runtime-registry";
import type {
  BlacklistSummaryResponse,
  DailyDigestResponse,
  HealthResponse,
  PegSummaryResponse,
  StabilityIndexResponse,
} from "@shared/types";

export interface LightApiQueryOptions {
  enabled?: boolean;
  retry?: number | boolean;
}

export function useLightApiQuery<T>(
  descriptor: FrontendApiQueryDescriptor<T>,
  options: LightApiQueryOptions = { retry: 1 },
) {
  const { staleTime, refetchInterval } = getPollingWindow(descriptor.producerIntervalMs);
  const retryOption = Object.prototype.hasOwnProperty.call(options, "retry")
    ? { retry: options.retry }
    : {};

  return useQuery({
    queryKey: ["api", ...descriptor.queryKey],
    queryFn: () => fetchLightApiJson(descriptor),
    enabled: options.enabled ?? true,
    staleTime,
    refetchInterval,
    ...retryOption,
  });
}

export function useSidebarPegSummarySignal() {
  return useLightApiQuery<PegSummaryResponse>(FRONTEND_API_QUERY_RUNTIME_REGISTRY.pegSummary);
}

export function useSidebarStabilityIndexSignal() {
  return useLightApiQuery<StabilityIndexResponse>(FRONTEND_API_QUERY_RUNTIME_REGISTRY.stabilityIndex);
}

export function useSidebarBlacklistSignal(enabled: boolean) {
  return useLightApiQuery<BlacklistSummaryResponse>(
    FRONTEND_API_QUERY_RUNTIME_REGISTRY.blacklistSummary,
    { enabled, retry: 1 },
  );
}

export function useSidebarHealthSignal() {
  return useLightApiQuery<HealthResponse>(FRONTEND_API_QUERY_RUNTIME_REGISTRY.health);
}

export function useSidebarDailyDigestSignal() {
  return useLightApiQuery<DailyDigestResponse>(FRONTEND_API_QUERY_RUNTIME_REGISTRY.dailyDigest);
}
