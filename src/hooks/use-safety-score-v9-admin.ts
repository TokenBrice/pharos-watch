"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import {
  SafetyScoreV9AdminResponseSchema,
  type SafetyScoreV9AdminResponse,
} from "@shared/types/safety-score-v9-admin";
import { CRON_24H } from "@/lib/cron-intervals";
import { useAdminPollingQuery } from "./use-admin-polling-query";

export function useSafetyScoreV9Admin(): UseQueryResult<SafetyScoreV9AdminResponse, Error> {
  return useAdminPollingQuery<SafetyScoreV9AdminResponse>(
    ["safety-score-v9-candidate"],
    API_PATHS.adminSafetyScoreV9(),
    CRON_24H,
    { schema: SafetyScoreV9AdminResponseSchema },
  );
}
