"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import type { ApiKeyAuditLogResponse } from "@shared/types";
import { ApiKeyAuditLogResponseSchema } from "@shared/types/api-keys";
import { CRON_1MIN } from "@/lib/cron-intervals";
import { useAdminPollingQuery } from "./use-admin-polling-query";

const AUDIT_HISTORY_LIMIT = 50;

export type ApiKeyAuditLogTarget = number | null | "global";

export function buildApiKeyAuditLogPath(target: Exclude<ApiKeyAuditLogTarget, null>): string {
  const params = new URLSearchParams();
  if (typeof target === "number") params.set("apiKeyId", String(target));
  params.set("limit", String(AUDIT_HISTORY_LIMIT));
  return `${API_PATHS.apiKeyAuditLog()}?${params.toString()}`;
}

export function useApiKeyAuditLog(target: ApiKeyAuditLogTarget): UseQueryResult<ApiKeyAuditLogResponse, Error> {
  const path = buildApiKeyAuditLogPath(target ?? "global");

  return useAdminPollingQuery<ApiKeyAuditLogResponse>(["api-key-audit-log", target], path, CRON_1MIN, {
    enabled: target != null,
    schema: ApiKeyAuditLogResponseSchema,
  });
}
