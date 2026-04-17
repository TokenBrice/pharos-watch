import { handleStatus } from "../api/status";
import { handleStatusHistory } from "../api/status-history";
import { handleRequestSourceStats } from "../api/request-source-stats";
import { handleApiKeyAuditLog } from "../api/api-key-audit-log";
import { handleApiKeys } from "../api/api-keys";
import { handleDiscoveryCandidates } from "../api/discovery";
import { handleAdminActionLog } from "../api/admin-action-log";
import { handleDebugSyncState, handleResetBlacklistSync, handleTriggerDigest } from "../api/admin-actions";
import { makeAdminRoute } from "../lib/route-wrappers";
import { defineStaticRoute, type StaticRouteDefinition } from "./shared";

export const OPS_STATIC_ROUTES = [
  defineStaticRoute("status", ({ db, trustedAdmin, request, coingeckoApiKey, cloudflareD1StatusBindings }) =>
    handleStatus(db, trustedAdmin, request, coingeckoApiKey, cloudflareD1StatusBindings)),
  defineStaticRoute("status-history", ({ db, trustedAdmin, request }) => handleStatusHistory(db, trustedAdmin, request)),
  defineStaticRoute("request-source-stats", ({ db, trustedAdmin, request }) =>
    handleRequestSourceStats(db, trustedAdmin, request)),
  defineStaticRoute("api-keys", ({ db, trustedAdmin, request, apiKeyHashPepper }) =>
    handleApiKeys(db, trustedAdmin, request, apiKeyHashPepper)),
  defineStaticRoute("api-key-audit-log", ({ db, trustedAdmin, request }) =>
    handleApiKeyAuditLog(db, trustedAdmin, request)),
  defineStaticRoute("trigger-digest", handleTriggerDigest),
  defineStaticRoute("admin-action-log", handleAdminActionLog),
  defineStaticRoute("reset-blacklist-sync", handleResetBlacklistSync),
  defineStaticRoute("debug-sync-state", handleDebugSyncState),
  defineStaticRoute("discovery-candidates", makeAdminRoute(
    "route-discovery-candidates",
    ({ db, url }) => handleDiscoveryCandidates(db, url),
  )),
] as const satisfies readonly StaticRouteDefinition[];
