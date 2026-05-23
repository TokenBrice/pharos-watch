"use client";

import { useQuery } from "@tanstack/react-query";
import type { StabilityIndexResponse } from "@shared/types";
import { fetchLightApiJson } from "@/lib/light-api-client";
import { getPollingWindow } from "@/hooks/use-api-query";
import { FRONTEND_API_QUERY_REGISTRY } from "@/lib/api-query-registry";

type StabilityIndexLightResponse = Pick<StabilityIndexResponse, "current" | "history">;

export function useStabilityIndexLight() {
  const descriptor = FRONTEND_API_QUERY_REGISTRY.stabilityIndex;
  const { staleTime, refetchInterval } = getPollingWindow(descriptor.producerIntervalMs);
  return useQuery({
    queryKey: ["api", ...descriptor.queryKey],
    queryFn: () => fetchLightApiJson<StabilityIndexLightResponse>(descriptor.path),
    staleTime,
    refetchInterval,
  });
}
