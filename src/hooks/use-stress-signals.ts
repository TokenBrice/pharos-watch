"use client";

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
    "/api/stress-signals",
    CRON_15MIN,
    { schema: StressSignalsAllResponseSchema },
  );
}

export function useStressSignalDetail(stablecoinId: string, days = 30) {
  return useApiQueryWithMeta<StressSignalDetailResponse>(
    ["stress-signals", stablecoinId, days],
    `/api/stress-signals?stablecoin=${stablecoinId}&days=${days}`,
    CRON_15MIN,
    { enabled: !!stablecoinId, schema: StressSignalDetailResponseSchema },
  );
}
