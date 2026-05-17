"use client";

import { useQuery } from "@tanstack/react-query";
import { API_PATHS } from "@shared/lib/api-endpoints";
import type { StabilityIndexResponse } from "@shared/types";
import { fetchLightApiJson } from "@/lib/light-api-client";
import { getPollingWindow } from "@/hooks/use-api-query";
import { CRON_30MIN } from "@/lib/cron-intervals";

type StabilityIndexLightResponse = Pick<StabilityIndexResponse, "current" | "history">;

export function useStabilityIndexLight() {
  const { staleTime, refetchInterval } = getPollingWindow(CRON_30MIN);
  const path = API_PATHS.stabilityIndex();
  return useQuery({
    queryKey: ["api", path],
    queryFn: () => fetchLightApiJson<StabilityIndexLightResponse>(path),
    staleTime,
    refetchInterval,
  });
}
