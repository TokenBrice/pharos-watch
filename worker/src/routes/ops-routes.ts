import { defineLazyStaticRoute, type StaticRouteDefinition } from "./shared";

export const OPS_STATIC_ROUTES = [
  defineLazyStaticRoute("status", () => import("../api/status").then(({ handleStatus }) => handleStatus)),
  defineLazyStaticRoute("status-history", () =>
    import("../api/status-history").then(({ handleStatusHistoryRoute }) => handleStatusHistoryRoute),
  ),
  defineLazyStaticRoute("request-source-stats", () =>
    import("../api/request-source-stats").then(({ handleRequestSourceStats }) => handleRequestSourceStats),
  ),
  defineLazyStaticRoute("api-keys", () =>
    import("../api/api-keys").then(({ handleApiKeysRoute }) => handleApiKeysRoute),
  ),
  defineLazyStaticRoute("credential-lifecycle-summary", () =>
    import("../api/api-keys").then(
      ({ handleCredentialLifecycleSummaryRoute }) => handleCredentialLifecycleSummaryRoute,
    ),
  ),
  defineLazyStaticRoute("api-key-audit-log", () =>
    import("../api/api-key-audit-log").then(({ handleApiKeyAuditLog }) => handleApiKeyAuditLog),
  ),
  defineLazyStaticRoute("api-key-requests-admin", () =>
    import("../api/api-key-requests").then(({ handleApiKeyRequestsAdminRoute }) => handleApiKeyRequestsAdminRoute),
  ),
  defineLazyStaticRoute("trigger-digest", () =>
    import("../api/admin-actions").then(({ handleTriggerDigest }) => handleTriggerDigest),
  ),
  defineLazyStaticRoute("admin-action-log", () =>
    import("../api/admin-action-log").then(({ handleAdminActionLog }) => handleAdminActionLog),
  ),
  defineLazyStaticRoute("reset-blacklist-sync", () =>
    import("../api/admin-actions").then(({ handleResetBlacklistSync }) => handleResetBlacklistSync),
  ),
  defineLazyStaticRoute("debug-sync-state", () =>
    import("../api/admin-actions").then(({ handleDebugSyncState }) => handleDebugSyncState),
  ),
] as const satisfies readonly StaticRouteDefinition[];
