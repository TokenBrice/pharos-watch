"use client";

import { API_PATHS } from "@shared/lib/api-endpoints";
import { useApiQueryWithMeta, CRON_15MIN } from "./use-api-query";
import type {
  StressSignalsAllResponse,
  StressSignalDetailResponse,
} from "@shared/types";
import {
  StressSignalsAllResponseSchema,
  StressSignalDetailResponseSchema,
} from "@shared/types";

export function useStressSignals() {
  return useApiQueryWithMeta<StressSignalsAllResponse>(
    ["stress-signals"],
    API_PATHS.stressSignals(),
    CRON_15MIN,
    { schema: StressSignalsAllResponseSchema },
  );
}

export function useStressSignalDetail(stablecoinId: string, days = 30) {
  return useApiQueryWithMeta<StressSignalDetailResponse>(
    ["stress-signals", stablecoinId, days],
    API_PATHS.stressSignals(stablecoinId, days),
    CRON_15MIN,
    { enabled: !!stablecoinId, schema: StressSignalDetailResponseSchema },
  );
}
