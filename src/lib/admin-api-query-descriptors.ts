import { API_PATHS, buildQueryPath } from "@shared/lib/api-endpoints/paths";
import type {
  ApiKeyAuditLogResponse,
  ApiKeyListResponse,
  ApiKeySelfServeRequestAdminListResponse,
  ApiKeySelfServeStatus,
  ApiRequestAttributionResponse,
  CredentialLifecycleSummaryResponse,
  StatusHistoryResponse,
  StatusResponse,
} from "@shared/types";
import { ApiKeySelfServeRequestAdminListResponseSchema } from "@shared/types/api-key-requests";
import { ApiKeyAuditLogResponseSchema, ApiKeyListResponseSchema, CredentialLifecycleSummaryResponseSchema } from "@shared/types/api-keys";
import { ApiRequestAttributionResponseSchema } from "@shared/types/request-source";
import { StatusHistoryResponseSchema, StatusResponseSchema } from "@shared/types/status";
import { AdminActionAuditLogResponseSchema, type AdminActionAuditLogResponse } from "@/lib/actions-workbench-model";
import { CRON_1MIN } from "@/lib/cron-intervals";
import type { SchemaLikeSource } from "@shared/lib/schema-like";

/**
 * Admin-surface twin of `FRONTEND_API_QUERY_DESCRIPTORS`. Every admin polling
 * hook is a one-line binding onto an entry here, so query keys, proxied paths,
 * response schemas, and enablement gates live in one table instead of eight
 * near-identical hook bodies.
 *
 * Admin surfaces have no cron producer: they read live ops state, so the whole
 * table polls on the generic one-minute ops budget rather than a cron cadence.
 */
export interface AdminApiQueryDescriptor<T> {
  queryKey: readonly unknown[];
  /** A thunk when the path embeds a value that must be recomputed per fetch. */
  path: string | (() => string);
  producerIntervalMs: number;
  schema: SchemaLikeSource<T>;
  /** Descriptor-level gate; a hook-level `enabled` override wins when supplied. */
  enabled?: boolean;
}

interface AdminApiQueryBase {
  queryKey: readonly unknown[];
  path: string | (() => string);
  enabled?: boolean;
}

function defineAdminApiQuery<T>(base: AdminApiQueryBase, schema: SchemaLikeSource<T>): AdminApiQueryDescriptor<T> {
  return { ...base, producerIntervalMs: CRON_1MIN, schema };
}

function defineParameterizedAdminApiQuery<TArgs extends unknown[], T>(
  schema: SchemaLikeSource<T>,
  buildBase: (...args: TArgs) => AdminApiQueryBase,
): (...args: TArgs) => AdminApiQueryDescriptor<T> {
  return (...args) => defineAdminApiQuery(buildBase(...args), schema);
}

const AUDIT_HISTORY_LIMIT = 50;
const ACTION_HISTORY_LIMIT = 100;
const REQUEST_SOURCE_DEFAULTS = {
  hours: 24,
  bucketSec: 3600,
  routeLimit: 5,
  apiKeyLimit: 25,
} as const;

export type ApiKeyAuditLogTarget = number | null | "global";

export type StatusHistoryWindow = "6h" | "24h" | "7d" | "30d";

export interface ApiKeyRequestsQueryOptions {
  status?: ApiKeySelfServeStatus;
  limit?: number;
}

const STATUS_HISTORY_WINDOW_SECONDS: Record<StatusHistoryWindow, number> = {
  "6h": 6 * 60 * 60,
  "24h": 24 * 60 * 60,
  "7d": 7 * 24 * 60 * 60,
  "30d": 30 * 24 * 60 * 60,
};

function buildApiKeyAuditLogPath(target: Exclude<ApiKeyAuditLogTarget, null>): string {
  const params = new URLSearchParams();
  if (typeof target === "number") params.set("apiKeyId", String(target));
  params.set("limit", String(AUDIT_HISTORY_LIMIT));
  return `${API_PATHS.apiKeyAuditLog()}?${params.toString()}`;
}

function buildStatusHistoryPath(window: StatusHistoryWindow): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return buildQueryPath(API_PATHS.statusHistoryBase(), {
    limit: 100,
    from: nowSeconds - STATUS_HISTORY_WINDOW_SECONDS[window],
  });
}

export const ADMIN_API_QUERY_DESCRIPTORS = {
  apiKeys: defineAdminApiQuery<ApiKeyListResponse>(
    { queryKey: ["api-keys"] as const, path: API_PATHS.apiKeys() },
    ApiKeyListResponseSchema,
  ),
  apiKeyAuditLog: defineParameterizedAdminApiQuery<[ApiKeyAuditLogTarget], ApiKeyAuditLogResponse>(
    ApiKeyAuditLogResponseSchema,
    (target) => ({
      queryKey: ["api-key-audit-log", target] as const,
      path: buildApiKeyAuditLogPath(target ?? "global"),
      enabled: target != null,
    }),
  ),
  credentialLifecycleSummary: defineAdminApiQuery<CredentialLifecycleSummaryResponse>(
    { queryKey: ["credential-lifecycle-summary"] as const, path: API_PATHS.credentialLifecycleSummary() },
    CredentialLifecycleSummaryResponseSchema,
  ),
  status: defineAdminApiQuery<StatusResponse>(
    { queryKey: ["status"] as const, path: API_PATHS.status() },
    StatusResponseSchema,
  ),
  statusHistory: defineParameterizedAdminApiQuery<[StatusHistoryWindow], StatusHistoryResponse>(
    StatusHistoryResponseSchema,
    (window) => ({
      queryKey: ["status-history", window] as const,
      // Thunk: `from` is `Date.now()`-derived and must not freeze at render time.
      path: () => buildStatusHistoryPath(window),
    }),
  ),
  adminActionLog: defineAdminApiQuery<AdminActionAuditLogResponse>(
    {
      queryKey: ["admin-action-log"] as const,
      path: buildQueryPath(API_PATHS.adminActionLog(), { limit: ACTION_HISTORY_LIMIT }),
    },
    AdminActionAuditLogResponseSchema,
  ),
  requestSourceStats: defineAdminApiQuery<ApiRequestAttributionResponse>(
    {
      queryKey: [
        "request-source-stats",
        REQUEST_SOURCE_DEFAULTS.hours,
        REQUEST_SOURCE_DEFAULTS.bucketSec,
        REQUEST_SOURCE_DEFAULTS.routeLimit,
        REQUEST_SOURCE_DEFAULTS.apiKeyLimit,
      ] as const,
      path: API_PATHS.requestSourceStats({ ...REQUEST_SOURCE_DEFAULTS }),
    },
    ApiRequestAttributionResponseSchema,
  ),
  apiKeyRequests: defineParameterizedAdminApiQuery<
    [ApiKeyRequestsQueryOptions],
    ApiKeySelfServeRequestAdminListResponse
  >(ApiKeySelfServeRequestAdminListResponseSchema, (options) => {
    const limit = options.limit ?? 50;
    return {
      queryKey: ["api-key-requests", options.status ?? "all", limit] as const,
      path: buildQueryPath(API_PATHS.apiKeyRequestsAdmin(), { status: options.status, limit }),
    };
  }),
} as const;
