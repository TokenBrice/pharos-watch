"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import type { ApiKeyAuditLogResponse } from "@shared/types";
import { ADMIN_API_QUERY_DESCRIPTORS, type ApiKeyAuditLogTarget } from "@/lib/admin-api-query-descriptors";
import { useRegisteredAdminQuery } from "./use-admin-polling-query";

export type { ApiKeyAuditLogTarget };

export function useApiKeyAuditLog(target: ApiKeyAuditLogTarget): UseQueryResult<ApiKeyAuditLogResponse, Error> {
  return useRegisteredAdminQuery(ADMIN_API_QUERY_DESCRIPTORS.apiKeyAuditLog(target));
}
