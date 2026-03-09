"use client";

import { useApiQuery, CRON_15MIN } from "@/hooks/use-api-query";
import {
  StabilityIndexResponseSchema,
  type StabilityIndexResponse,
  type StabilityContributor,
} from "@shared/types";

export type { StabilityContributor };

export function useStabilityIndex() {
  return useApiQuery<StabilityIndexResponse>(
    ["stability-index"],
    "/api/stability-index",
    CRON_15MIN,
    { schema: StabilityIndexResponseSchema },
  );
}

export function useStabilityIndexDetail() {
  return useApiQuery<StabilityIndexResponse>(
    ["stability-index-detail"],
    "/api/stability-index?detail=true",
    CRON_15MIN,
    { schema: StabilityIndexResponseSchema },
  );
}
