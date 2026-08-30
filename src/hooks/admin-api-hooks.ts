"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import type {
  ApiKeyAuditLogResponse,
  ApiKeySelfServeRequestAdminListResponse,
  StatusHistoryResponse,
} from "@shared/types";
import {
  ADMIN_API_QUERY_DESCRIPTORS,
  type AdminApiQueryDescriptor,
  type ApiKeyAuditLogTarget,
  type ApiKeyRequestsQueryOptions,
  type StatusHistoryWindow,
} from "@/lib/admin-api-query-descriptors";
import { useRegisteredAdminQuery } from "./use-admin-polling-query";

export type { ApiKeyAuditLogTarget, StatusHistoryWindow };

type AdminQueryOverrides = { enabled?: boolean };

function bindRegisteredAdminQuery<T>(descriptor: AdminApiQueryDescriptor<T>): () => UseQueryResult<T, Error>;
function bindRegisteredAdminQuery<T>(
  descriptor: AdminApiQueryDescriptor<T>,
  defaults: AdminQueryOverrides | undefined,
): (overrides?: AdminQueryOverrides) => UseQueryResult<T, Error>;
function bindRegisteredAdminQuery<T>(
  descriptor: AdminApiQueryDescriptor<T>,
  defaults?: AdminQueryOverrides,
) {
  return function useBoundRegisteredAdminQuery(overrides?: AdminQueryOverrides) {
    return useRegisteredAdminQuery(descriptor, { ...defaults, ...overrides });
  };
}

export const useAdminActionLog = bindRegisteredAdminQuery(ADMIN_API_QUERY_DESCRIPTORS.adminActionLog);

export function useApiKeyAuditLog(target: ApiKeyAuditLogTarget): UseQueryResult<ApiKeyAuditLogResponse, Error> {
  return useRegisteredAdminQuery(ADMIN_API_QUERY_DESCRIPTORS.apiKeyAuditLog(target));
}

export function useApiKeyRequests(
  options: ApiKeyRequestsQueryOptions = {},
): UseQueryResult<ApiKeySelfServeRequestAdminListResponse, Error> {
  return useRegisteredAdminQuery(ADMIN_API_QUERY_DESCRIPTORS.apiKeyRequests(options));
}

export const useApiKeys = bindRegisteredAdminQuery(ADMIN_API_QUERY_DESCRIPTORS.apiKeys);
export const useCredentialLifecycleSummary = bindRegisteredAdminQuery(ADMIN_API_QUERY_DESCRIPTORS.credentialLifecycleSummary);
export const useRequestSourceStats = bindRegisteredAdminQuery(
  ADMIN_API_QUERY_DESCRIPTORS.requestSourceStats,
  undefined,
);

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
export const useStatus = bindRegisteredAdminQuery(ADMIN_API_QUERY_DESCRIPTORS.status, undefined);
