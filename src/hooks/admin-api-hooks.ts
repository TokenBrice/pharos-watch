"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import type {
  ApiKeyAuditLogResponse,
  ApiKeyListResponse,
  ApiKeySelfServeRequestAdminListResponse,
  ApiRequestAttributionResponse,
  CredentialLifecycleSummaryResponse,
  StatusHistoryResponse,
  StatusResponse,
} from "@shared/types";
import {
  ADMIN_API_QUERY_DESCRIPTORS,
  type ApiKeyAuditLogTarget,
  type ApiKeyRequestsQueryOptions,
  type StatusHistoryWindow,
} from "@/lib/admin-api-query-descriptors";
import type { AdminActionAuditLogResponse } from "@/lib/actions-workbench-model";
import { useRegisteredAdminQuery } from "./use-admin-polling-query";

export type { ApiKeyAuditLogTarget, StatusHistoryWindow };

export function useAdminActionLog(): UseQueryResult<AdminActionAuditLogResponse, Error> {
  return useRegisteredAdminQuery(ADMIN_API_QUERY_DESCRIPTORS.adminActionLog);
}

export function useApiKeyAuditLog(target: ApiKeyAuditLogTarget): UseQueryResult<ApiKeyAuditLogResponse, Error> {
  return useRegisteredAdminQuery(ADMIN_API_QUERY_DESCRIPTORS.apiKeyAuditLog(target));
}

export function useApiKeyRequests(
  options: ApiKeyRequestsQueryOptions = {},
): UseQueryResult<ApiKeySelfServeRequestAdminListResponse, Error> {
  return useRegisteredAdminQuery(ADMIN_API_QUERY_DESCRIPTORS.apiKeyRequests(options));
}

export function useApiKeys(): UseQueryResult<ApiKeyListResponse, Error> {
  return useRegisteredAdminQuery(ADMIN_API_QUERY_DESCRIPTORS.apiKeys);
}

export function useCredentialLifecycleSummary(): UseQueryResult<CredentialLifecycleSummaryResponse, Error> {
  return useRegisteredAdminQuery(ADMIN_API_QUERY_DESCRIPTORS.credentialLifecycleSummary);
}

export function useRequestSourceStats(
  options: { enabled?: boolean } = {},
): UseQueryResult<ApiRequestAttributionResponse, Error> {
  return useRegisteredAdminQuery(ADMIN_API_QUERY_DESCRIPTORS.requestSourceStats, options);
}

export function useStatusHistory(
  window: StatusHistoryWindow,
  options: { enabled?: boolean } = {},
): UseQueryResult<StatusHistoryResponse, Error> {
  return useRegisteredAdminQuery(ADMIN_API_QUERY_DESCRIPTORS.statusHistory(window), options);
}

/**
 * Fetches /api/status through the ops-host admin proxy.
 * Auto-refreshes every 60s for live ops monitoring.
 */
export function useStatus(options: { enabled?: boolean } = {}): UseQueryResult<StatusResponse, Error> {
  return useRegisteredAdminQuery(ADMIN_API_QUERY_DESCRIPTORS.status, options);
}
