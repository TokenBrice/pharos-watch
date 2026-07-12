import { handleStatus } from "../api/status";
import { handleStatusHistoryRoute } from "../api/status-history";
import { handleRequestSourceStats } from "../api/request-source-stats";
import { handleYieldSourceDecisions } from "../api/yield-source-decisions";
import { handleApiKeyAuditLog } from "../api/api-key-audit-log";
import { handleApiKeysRoute, handleCredentialLifecycleSummaryRoute } from "../api/api-keys";
import { handleApiKeyRequestsAdminRoute } from "../api/api-key-requests";
import { handleDiscoveryCandidates } from "../api/discovery";
import { handleAdminActionLog } from "../api/admin-action-log";
import { handleDebugSyncState, handleResetBlacklistSync, handleTriggerDigest } from "../api/admin-actions";
import { makeAdminRoute } from "../lib/route-wrappers";
import { defineStaticRoute, type StaticRouteDefinition } from "./shared";

export const OPS_STATIC_ROUTES = [
  defineStaticRoute("status", ({
    db,
    trustedAdmin,
    request,
    coingeckoApiKey,
    cloudflareD1StatusBindings,
    workerJobLedgerMode,
    workerJobLedgerAllowlist,
    workerCanaryMode,
  }) => handleStatus(
    db,
    trustedAdmin,
    request,
    coingeckoApiKey,
    cloudflareD1StatusBindings,
    workerJobLedgerMode,
    workerJobLedgerAllowlist,
    workerCanaryMode,
  )),
  defineStaticRoute("status-history", handleStatusHistoryRoute),
  defineStaticRoute("request-source-stats", ({ db, trustedAdmin, request }) =>
    handleRequestSourceStats(db, trustedAdmin, request)),
  defineStaticRoute("yield-source-decisions", handleYieldSourceDecisions),
  defineStaticRoute("api-keys", handleApiKeysRoute),
  defineStaticRoute("credential-lifecycle-summary", handleCredentialLifecycleSummaryRoute),
  defineStaticRoute("api-key-audit-log", ({ db, trustedAdmin, request }) =>
    handleApiKeyAuditLog(db, trustedAdmin, request)),
  defineStaticRoute("api-key-requests-admin", handleApiKeyRequestsAdminRoute),
  defineStaticRoute("trigger-digest", handleTriggerDigest),
  defineStaticRoute("admin-action-log", handleAdminActionLog),
  defineStaticRoute("reset-blacklist-sync", handleResetBlacklistSync),
  defineStaticRoute("debug-sync-state", handleDebugSyncState),
  defineStaticRoute("discovery-candidates", makeAdminRoute(
    "route-discovery-candidates",
    ({ db, url }) => handleDiscoveryCandidates(db, url),
  )),
] as const satisfies readonly StaticRouteDefinition[];
