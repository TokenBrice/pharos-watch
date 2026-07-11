"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import type { CredentialLifecycleSummaryResponse } from "@shared/types";
import { CredentialLifecycleSummaryResponseSchema } from "@shared/types/api-keys";
import { CRON_1MIN } from "@/lib/cron-intervals";
import { useAdminPollingQuery } from "./use-admin-polling-query";

export function useCredentialLifecycleSummary(): UseQueryResult<CredentialLifecycleSummaryResponse, Error> {
  return useAdminPollingQuery<CredentialLifecycleSummaryResponse>(
    ["credential-lifecycle-summary"],
    API_PATHS.credentialLifecycleSummary(),
    CRON_1MIN,
    { schema: CredentialLifecycleSummaryResponseSchema },
  );
}
