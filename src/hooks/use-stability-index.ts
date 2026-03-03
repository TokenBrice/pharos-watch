"use client";

import { useApiQuery, CRON_15MIN } from "@/hooks/use-api-query";
import {
  StabilityIndexResponseSchema,
  type StabilityIndexResponse,
  type StabilityContributor,
  type StabilityIndexCurrent,
  type StabilityIndexHistoryPoint,
} from "@/lib/types";

export type { StabilityContributor, StabilityIndexCurrent, StabilityIndexHistoryPoint };

export type StabilityIndexData = StabilityIndexResponse;

export function useStabilityIndex() {
  return useApiQuery<StabilityIndexData>(
    ["stability-index"],
    "/api/stability-index",
    CRON_15MIN,
    { schema: StabilityIndexResponseSchema },
  );
}

export type StabilityIndexDetailHistoryPoint = StabilityIndexHistoryPoint;
export type StabilityIndexDetailData = StabilityIndexResponse;

export function useStabilityIndexDetail() {
  return useApiQuery<StabilityIndexDetailData>(
    ["stability-index-detail"],
    "/api/stability-index?detail=true",
    CRON_15MIN,
    { schema: StabilityIndexResponseSchema },
  );
}
