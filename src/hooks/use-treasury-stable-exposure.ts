"use client";

import { API_PATHS } from "@shared/lib/api-endpoints";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { TreasuryStableExposureResponseSchema, type TreasuryStableExposureResponse } from "@shared/types";
import { CRON_24H } from "@/lib/cron-intervals";
import { useApiQueryWithMeta } from "./use-api-query";

export function useTreasuryStableExposure() {
  return useApiQueryWithMeta<TreasuryStableExposureResponse>(
    ["treasury-stable-exposure"],
    API_PATHS.treasuryStableExposure(),
    CRON_24H,
    {
      schema: TreasuryStableExposureResponseSchema,
      metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.treasuryStableExposure,
    },
  );
}
