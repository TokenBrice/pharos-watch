"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import type { CredentialLifecycleSummaryResponse } from "@shared/types";
import { ADMIN_API_QUERY_DESCRIPTORS } from "@/lib/admin-api-query-descriptors";
import { useRegisteredAdminQuery } from "./use-admin-polling-query";

export function useCredentialLifecycleSummary(): UseQueryResult<CredentialLifecycleSummaryResponse, Error> {
  return useRegisteredAdminQuery(ADMIN_API_QUERY_DESCRIPTORS.credentialLifecycleSummary);
}
