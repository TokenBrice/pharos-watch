"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import type { ApiKeyAuditLogResponse } from "@shared/types";
import { ApiKeyAuditLogResponseSchema } from "@shared/types/api-keys";
import { CRON_1MIN } from "@/lib/cron-intervals";
import { useAdminPollingQuery } from "./use-admin-polling-query";

const AUDIT_HISTORY_LIMIT = 50;

export function useApiKeyAuditLog(apiKeyId: number | null): UseQueryResult<ApiKeyAuditLogResponse, Error> {
  const path = () => {
    const params = new URLSearchParams({
      apiKeyId: String(apiKeyId),
      limit: String(AUDIT_HISTORY_LIMIT),
    });
    return `${API_PATHS.apiKeyAuditLog()}?${params.toString()}`;
  };

  return useAdminPollingQuery<ApiKeyAuditLogResponse>(["api-key-audit-log", apiKeyId], path, CRON_1MIN, {
    enabled: apiKeyId != null,
    schema: ApiKeyAuditLogResponseSchema,
  });
}
