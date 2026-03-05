"use client";

import { useApiQuery, CRON_15MIN } from "./use-api-query";
import type {
  StressSignalsAllResponse,
  StressSignalDetailResponse,
  StressSignalEntry,
} from "@shared/types";
import {
  StressSignalsAllResponseSchema,
  StressSignalDetailResponseSchema,
} from "@shared/types";

export type { StressSignalEntry };

export function useStressSignals() {
  return useApiQuery<StressSignalsAllResponse>(
    ["stress-signals"],
    "/api/stress-signals",
    CRON_15MIN,
    { schema: StressSignalsAllResponseSchema },
  );
}

export function useStressSignalDetail(stablecoinId: string, days = 30) {
  return useApiQuery<StressSignalDetailResponse>(
    ["stress-signals", stablecoinId, days],
    `/api/stress-signals?stablecoin=${stablecoinId}&days=${days}`,
    CRON_15MIN,
    { enabled: !!stablecoinId, schema: StressSignalDetailResponseSchema },
  );
}
