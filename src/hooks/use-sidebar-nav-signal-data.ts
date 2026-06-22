"use client";

import { useQuery } from "@tanstack/react-query";
import { useRegisteredApiQueryWithMeta } from "@/hooks/api-hooks";
import { getPollingWindow } from "@/hooks/use-api-query";
import { apiFetch } from "@/lib/api";
import { FRONTEND_API_QUERY_REGISTRY, type FrontendApiQueryDescriptor } from "@/lib/api-query-registry";
import type { BlacklistSummaryResponse, DailyDigestResponse, HealthResponse, PegSummaryResponse } from "@shared/types";

export interface LightApiQueryOptions {
  enabled?: boolean;
  retry?: number | boolean;
}

const DEFAULT_LIGHT_QUERY_OPTIONS: LightApiQueryOptions = { retry: 1 };

export function useLightApiQuery<T>(
  descriptor: FrontendApiQueryDescriptor<T>,
  options: LightApiQueryOptions = DEFAULT_LIGHT_QUERY_OPTIONS,
) {
  if (descriptor.metaMaxAgeSec != null) {
    throw new Error("useLightApiQuery cannot share a meta descriptor's cache shape");
  }

  const { staleTime, refetchInterval } = getPollingWindow(descriptor.producerIntervalMs);
  const retryOption = Object.prototype.hasOwnProperty.call(options, "retry") ? { retry: options.retry } : {};

  return useQuery({
    queryKey: descriptor.queryKey,
    queryFn: () => apiFetch<T>(descriptor.path, descriptor.schema),
    enabled: options.enabled ?? true,
    staleTime,
    refetchInterval,
    ...retryOption,
  });
}

export function useLightApiQueryWithMeta<T>(
  descriptor: FrontendApiQueryDescriptor<T>,
  options: LightApiQueryOptions = DEFAULT_LIGHT_QUERY_OPTIONS,
) {
  if (descriptor.metaMaxAgeSec == null) {
    throw new Error("useLightApiQueryWithMeta requires a meta descriptor");
  }

  return useRegisteredApiQueryWithMeta<T>(descriptor, options);
}

export function useSidebarPegSummarySignal() {
  return useLightApiQueryWithMeta<PegSummaryResponse>(FRONTEND_API_QUERY_REGISTRY.pegSummary);
}

export function useSidebarBlacklistSignal(enabled: boolean) {
  return useLightApiQueryWithMeta<BlacklistSummaryResponse>(FRONTEND_API_QUERY_REGISTRY.blacklistSummary, {
    enabled,
    retry: 1,
  });
}

export function useSidebarHealthSignal() {
  return useLightApiQuery<HealthResponse>(FRONTEND_API_QUERY_REGISTRY.health);
}

export function useSidebarDailyDigestSignal() {
  return useLightApiQuery<DailyDigestResponse>(FRONTEND_API_QUERY_REGISTRY.dailyDigest);
}
